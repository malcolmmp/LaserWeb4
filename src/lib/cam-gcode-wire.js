'use strict';

import { dist, cut, insideOutside, pocket, reduceCamPaths, separateTabs, vCarve } from './cam';
import { mmToClipperScale, offset, rawPathsToClipperPaths, union } from './mesh';

// Convert mill paths to gcode.
//      paths:          Array of CamPath
//      ramp:           Ramp these paths?
//      scale:          Factor to convert Clipper units to gcode units
//      useZ:           Use Z coordinates in paths? (defaults to false, used for vPocket)
//      offsetX:        Offset X (gcode units)
//      offsetY:        Offset Y (gcode units)
//      decimal:        Number of decimal places to keep in gcode
//      topZ:           Top of area to cut (gcode units)
//      botZ:           Bottom of area to cut (gcode units)
//      safeZ:          Z position to safely move over uncut areas (gcode units)
//      passDepth:      Cut depth for each pass (gcode units)
//      plungeFeed:     Feedrate to plunge cutter (gcode units)
//      cutFeed:        Feedrate for horizontal cuts (gcode units)
//      tabGeometry:    Tab geometry (optional)
//      tabZ:           Z position over tabs (required if tabGeometry is not empty) (gcode units)
export function getWireGcode(props) {
    let { paths, ramp, scale, useZ, offsetX, offsetY, decimal, topZ, botZ, safeZ, passDepth,
        plungeFeed, cutFeed, tabGeometry, tabZ, toolSpeed } = props;

    let plungeFeedGcode = ' F' + plungeFeed;
    let cutFeedGcode = ' F' + cutFeed;

    if (useZ === undefined)
        useZ = false;

    if (tabGeometry === undefined || tabZ <= botZ) {
        tabGeometry = [];
        tabZ = botZ;
    }

    let retractGcode =
        '; Retract\r\n' +
        'G0 Z' + safeZ.toFixed(decimal) + '\r\n';

    let retractForTabGcode =
        '; Retract for tab\r\n' +
        'G0 Z' + tabZ.toFixed(decimal) + '\r\n';

    let gcode = retractGcode;

    function getX(p) {
        return p.X * scale + offsetX;
    }

    function getY(p) {
        return p.Y * scale + offsetY;
    }

    function convertPoint(p, useZ) {
        let result = ' X' + (p.X * scale + offsetX).toFixed(decimal) + ' Y' + (p.Y * scale + offsetY).toFixed(decimal);
        if (useZ)
            result += ' Z' + (p.Z * scale + topZ).toFixed(decimal);
        return result;
    }

    for (let pathIndex = 0; pathIndex < paths.length; ++pathIndex) {
        let path = paths[pathIndex];
        let origPath = path.path;
        if (origPath.length === 0)
            continue;
        let separatedPaths = separateTabs(origPath, tabGeometry);

        gcode +=
            '\r\n' +
            '; Path ' + pathIndex + '\r\n';

        let currentZ = safeZ;
        let finishedZ = topZ;
        while (finishedZ > botZ || useZ) {
            let nextZ = Math.max(finishedZ - passDepth, botZ);
            if (currentZ < safeZ && (!path.safeToClose || tabGeometry.length > 0)) {
                gcode += retractGcode;
                currentZ = safeZ;
            }

            if (tabGeometry.length === 0)
                currentZ = finishedZ;
            else
                currentZ = Math.max(finishedZ, tabZ);
            gcode +=
                '; Rapid to initial position\r\n' +
                'G0' + convertPoint(origPath[0], false) + '\r\n' +
                'G0 Z' + currentZ.toFixed(decimal) + '\r\n';

            let selectedPaths;
            if (nextZ >= tabZ || useZ)
                selectedPaths = [origPath];
            else
                selectedPaths = separatedPaths;

            for (let selectedIndex = 0; selectedIndex < selectedPaths.length; ++selectedIndex) {
                let selectedPath = selectedPaths[selectedIndex];
                if (selectedPath.length === 0)
                    continue;

                if (!useZ) {
                    let selectedZ;
                    if (selectedIndex & 1)
                        selectedZ = tabZ;
                    else
                        selectedZ = nextZ;

                    if (selectedZ < currentZ) {
                        let executedRamp = false;
                        if (ramp) {
                            let minPlungeTime = (currentZ - selectedZ) / plungeFeed;
                            let idealDist = cutFeed * minPlungeTime;
                            let end;
                            let totalDist = 0;
                            for (end = 1; end < selectedPath.length; ++end) {
                                if (totalDist > idealDist)
                                    break;
                                totalDist += 2 * dist(getX(selectedPath[end - 1]), getY(selectedPath[end - 1]), getX(selectedPath[end]), getY(selectedPath[end]));
                            }
                            if (totalDist > 0) {
                                gcode += '; ramp\r\n'
                                executedRamp = true;
                                let rampPath = selectedPath.slice(0, end).concat(selectedPath.slice(0, end - 1).reverse());
                                let distTravelled = 0;
                                for (let i = 1; i < rampPath.length; ++i) {
                                    distTravelled += dist(getX(rampPath[i - 1]), getY(rampPath[i - 1]), getX(rampPath[i]), getY(rampPath[i]));
                                    let newZ = currentZ + distTravelled / totalDist * (selectedZ - currentZ);
                                    gcode += 'G1' + convertPoint(rampPath[i], false) + ' Z' + newZ.toFixed(decimal);
                                    if (i === 1) {
                                        gcode += ' F' + Math.min(totalDist / minPlungeTime, cutFeed).toFixed(decimal)
                                        if (toolSpeed) gcode += ' S' + toolSpeed;
                                    }
                                    gcode += '\r\n';
                                }
                            }
                        }
                        if (!executedRamp)
                            gcode +=
                                '; plunge\r\n' +
                                'G1 Z' + selectedZ.toFixed(decimal) + plungeFeedGcode
                        if (toolSpeed) gcode += ' S' + toolSpeed;
                        gcode += '\r\n';
                    } else if (selectedZ > currentZ) {
                        gcode += retractForTabGcode;
                    }
                    currentZ = selectedZ;
                } // !useZ

                gcode += '; cut\r\n';

                for (let i = 1; i < selectedPath.length; ++i) {
                    gcode += 'G1' + convertPoint(selectedPath[i], useZ);
                    if (i === 1) {
                        gcode += cutFeedGcode
                        if (toolSpeed) gcode += ' S' + toolSpeed;
                    }
                    gcode += '\r\n';
                }
            } // selectedIndex
            finishedZ = nextZ;
            if (useZ)
                break;
        } // while (finishedZ > botZ)
        gcode += retractGcode;
    } // pathIndex
    console.log("Finished with getWireGcode() function");
    return gcode;
}; // getMillGcode

export function getWireGcodeFromOp(settings, opIndex, op, geometry, openGeometry, tabGeometry, showAlert, done, progress) {
    let ok = true;
    if (op.millStartZ > op.millRapidZ) {
        showAlert("millStartZ must be <= millRapidZ", "danger");
        ok = false;
    }
    if (op.passDepth <= 0) {
        showAlert("Pass Depth must be greater than 0", "danger");
        ok = false;
    }
    if (op.type === 'Mill V Carve') {
        if (op.toolAngle <= 0 || op.toolAngle >= 180) {
            showAlert("Tool Angle must be in range (0, 180)", "danger");
            ok = false;
        }
    } else {
        if (op.millEndZ >= op.millStartZ) {
            showAlert("millEndZ must be < millStartZ", "danger");
            ok = false;
        }
        if (op.type !== 'Mill Cut' && op.toolDiameter <= 0) {
            showAlert("Tool Diameter must be greater than 0", "danger");
            ok = false;
        }
        if (op.stepOver <= 0 || op.stepOver > 100) {
            showAlert("Step Over must be in range 0-100%", "danger");
            ok = false;
        }
    }
    if (op.plungeRate <= 0) {
        showAlert("Plunge Rate must be greater than 0", "danger");
        ok = false;
    }
    if (op.cutRate <= 0) {
        showAlert("Cut Rate must be greater than 0", "danger");
        ok = false;
    }
    if (op.wearRatio <= 0) {
        showAlert("Wear Ratio must be greater than 0", "danger");
        ok = false;
    }
    console.log(op.wearRatio);
    if (!ok)
        done(false);

    if (tabGeometry && op.toolDiameter > 0)
        tabGeometry = offset(tabGeometry, op.toolDiameter / 2 * mmToClipperScale);

    let camPaths = [];
    if (op.type === 'Virtual Wire ECM Pocket') {
        if (op.margin)
            geometry = offset(geometry, -op.margin * mmToClipperScale);
        camPaths = pocket(geometry, op.toolDiameter * mmToClipperScale, op.stepOver, op.direction === 'Climb');
    } else if (op.type === 'Virtual Wire ECM Cut') {
        camPaths = cut(geometry, openGeometry, op.direction === 'Climb');
    } else if (op.type === 'Virtual Wire ECM Cut Inside') {
        if (op.margin)
            geometry = offset(geometry, -op.margin * mmToClipperScale);
        camPaths = insideOutside(geometry, op.toolDiameter * mmToClipperScale, true, op.cutWidth * mmToClipperScale, op.stepOver, op.direction === 'Climb', true);
    } else if (op.type === 'Virtual Wire ECM Cut Outside') {
        if (op.margin)
            geometry = offset(geometry, op.margin * mmToClipperScale);
        camPaths = insideOutside(geometry, op.toolDiameter * mmToClipperScale, false, op.cutWidth * mmToClipperScale, op.stepOver, op.direction === 'Climb', true);
    } else if (op.type === 'Virtual Wire ECM V Carve') {
        camPaths = vCarve(geometry, op.toolAngle, op.passDepth * mmToClipperScale);
    }

    for (let camPath of camPaths) {
        let path = camPath.path;
        for (let point of path) {
            point.X = Math.round(point.X / mmToClipperScale * 1000) * mmToClipperScale / 1000;
            point.Y = Math.round(point.Y / mmToClipperScale * 1000) * mmToClipperScale / 1000;
        }
    }
    reduceCamPaths(camPaths, op.segmentLength * mmToClipperScale);

    let feedScale = 1;
    if (settings.toolFeedUnits === 'mm/s')
        feedScale = 60;

    let gcode =
        "\r\n;" +
        "\r\n; Operation:    " + opIndex +
        "\r\n; Type:         " + op.type +
        "\r\n; Paths:        " + camPaths.length +
        "\r\n; Direction:    " + op.direction +
        "\r\n; Rapid Z:      " + op.millRapidZ +
        "\r\n; Start Z:      " + op.millStartZ +
        "\r\n; End Z:        " + op.millEndZ +
        "\r\n; Pass Depth:   " + op.passDepth +
        "\r\n; Plunge rate:  " + op.plungeRate + ' ' + settings.toolFeedUnits +
        "\r\n; Cut rate:     " + op.cutRate + ' ' + settings.toolFeedUnits +
        "\r\n; Wear Ratio:   " + op.wearRatio +
        "\r\n;\r\n";

    if (op.hookOperationStart.length) gcode += op.hookOperationStart;

    gcode += getWireGcode({
        paths: camPaths,
        ramp: op.ramp,
        scale: 1 / mmToClipperScale,
        useZ: op.type === 'Mill V Carve',
        offsetX: 0,
        offsetY: 0,
        decimal: 3,
        topZ: op.millStartZ,
        botZ: op.millEndZ,
        safeZ: op.millRapidZ,
        passDepth: op.passDepth,
        plungeFeed: op.plungeRate * feedScale,
        cutFeed: op.cutRate * feedScale,
        tabGeometry: op.type === 'Mill V Carve' ? [] : tabGeometry,
        tabZ: -op.tabDepth,
        toolSpeed: op.toolSpeed
    });

    if (op.hookOperationEnd.length) gcode += op.hookOperationEnd;

    let post_processed = rackGcodePostProcess(gcode, op.wearRatio);
    // done(gcode)
    done(post_processed)

} // getWireGcodeFromOp

function rackGcodePostProcess(gcode, wear_ratio) {
    console.log("Original Gcode: \n", gcode);
    const critcal_distance_threshold_for_segmentation = 0.05;
    
    const rapid_feedrate_for_G0_commands = 1200;
    let plunges_reordered = findAndReorderPlunges(gcode, wear_ratio);
    console.log("Plunges Reordered: \n", plunges_reordered);
    return plunges_reordered;
} 

function findAndReorderPlunges(gcode, wear_ratio) {
    // const plunge_initiation_string = "; plunge";
    // const lines = gcode.split('\n');

    // let plunges = "";
    // let last_xy = [0, 0];
    // for (let i = 0; i < lines.length; i++) {
    //     if (lines[i].substring(0, 8) === plunge_initiation_string) {
    //         console.log("Found a plunge");
    //         plunges += "G0 Z1.0\n";
    //         plunges += "G0 X" + last_xy[0] + " Y" + last_xy[1] + "\n";
    //         plunges += lines[i] + "\n" + lines[i + 1] + "\n";
    //     } 
    //     update_xy(lines[i], last_xy);
    // }
    // console.log("Plunges: \n", plunges);
    let plunges = find_plunges(gcode);
    let subdivided = subdivide_moves(gcode, 0.1);
    console.log("Subdivided: \n", subdivided);
    let z_added = add_z(subdivided, wear_ratio);
    console.log("Z Added: \n", z_added);
    let plunges_at_begining = "";
    let plunges_added_back = false;
    const line_to_add_plunges_before = "; Path 0 \n";
    let z_added_lines = z_added.split('\n');
    for (let i = 0; i < z_added_lines.length; i++) {
        if (z_added_lines[i].substring(0, 8) === line_to_add_plunges_before.substring(0, 8)) {
            console.log("Found the Path 0 line");
            if (!plunges_added_back) {
                plunges_at_begining += plunges + line_to_add_plunges_before + "\n";
            } else {
                console.log("MAJOR ERROR: Found the Path 0 line twice");
                plunges_at_begining += z_added_lines[i] + "\n";
            }
        } else {
            plunges_at_begining += z_added_lines[i] + "\n";
        }
    }
    return plunges_at_begining;
}

function find_plunges(gcode) {
    const plunge_initiation_string = "; plunge";
    const lines = gcode.split('\n');

    let plunges = "";
    let last_xy = [0, 0];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].substring(0, 8) === plunge_initiation_string) {
            console.log("Found a plunge");
            // Retract z before move to plunge start
            // let first_move = {g: 0, x: null, y: null, z: 1.0, f: null};
            // plunges += generate_gcode_move({g: 0, x: null, y: null, z: 1.0, f: null});
            plunges += move_as_str({g: 0, x: null, y: null, z: 1.0, f: null});
            // Move to plunge start
            plunges += move_as_str({g: 0, x: last_xy[0], y: last_xy[1], z: null, f: null});
            // plunges += "G0 Z1.0\n";
            // plunges += "G0 X" + last_xy[0] + " Y" + last_xy[1] + "\n";
            // Do plunge
            plunges += lines[i] + "\n" + lines[i + 1] + "\n";
        } 
        update_xy(lines[i], last_xy);
    }
    return plunges;
}

function add_z(gcode, wear_ratio) {
    let last_xy = [null, null];
    let lines = gcode.split('\n');
    let current_z = 0;
    // let first_x_found = false;
    // let first_y_found = false;

    let new_gcode = "";
    for (let i = 0; i < lines.length; i++) {
        let corrected = correct_line(lines[i], wear_ratio, last_xy, current_z);
        new_gcode += corrected;
    }
    return new_gcode;
}

function correct_line(gcode_line, wear_ratio, last_xy, current_z) {
    // let x = null;
    // let y = null;
    // let z = null;
    // let g_number = move_num(gcode_line);
    // let f = null;
    let line = parse_move(gcode_line);
    // let this_first_x_found = first_x_found;
    // let this_first_y_found = first_y_found;
    // let already_found = last_xy[0] !== null && last_xy[1] !== null;
    // let components = gcode_line.split(" ");
    // for (let i = 0; i < components.length; i++) {
    //     if (components[i].substring(0, 1) === "X") {
    //         x = parseFloat(components[i].substring(1, components[i].length));
    //         // has_x = true;
    //         // if () {
    //         //     this_first_x_found = true;
    //         // }
    //     } else if (components[i].substring(0, 1) === "Y") {
    //         y = parseFloat(components[i].substring(1, components[i].length));
    //         // has_y = true;
    //         // if (!this_first_y_found) {
    //         //     this_first_y_found = true;
    //         // }
    //     } else if (components[i].substring(0, 1) === "Z") {
    //         z = parseFloat(components[i].substring(1, components[i].length));
    //         // has_z = true;
    //     } else if (components[i].substring(0, 1) == "F") {
    //         f = parseFloat(components[i].substring(1, components[i].length));
    //         // has_f = true;
    //     }
    // }
    if (line.x !== null && line.y !== null && line.g !== null) {
        // Has x and y values
        // For the case were it has x and y values, we don't need to worry about the z value
        // because we will be overwriting it anyway
        let distance = get_magnitude(last_xy, [line.x, line.y]);
        // let gcode_str = ensure_segmentation_and_z(last_xy, [x, y], already_found, current_z, wear_ratio, g_number, real_f);
        last_xy[0] = line.x;
        last_xy[1] = line.y;
        current_z -= distance * wear_ratio;
        // let gcode_str = generate_gcode_move(g_number, x, y, current_z, f);
        let new_line = line;
        new_line.z = current_z;
        let gcode_str = move_as_str(new_line);
        return gcode_str;
    } else if (line.x !== null && line.y === null && line.g !== null) {
        // Just an x value
        let distance = get_magnitude(last_xy, [line.x, last_xy[1]]);
        // let gcode_str = ensure_segmentation_and_z(last_xy, [x, null], already_found, current_z, wear_ratio, g_number, real_f);
        // Update the last y value
        last_xy[0] = line.x;
        current_z -= distance * wear_ratio;
        // let gcode_str = generate_gcode_move(g_number, x, y, current_z, f);
        let new_line = line;
        new_line.z = current_z;
        let gcode_str = move_as_str(new_line);
        // let gcode_str = move_as_str({g: g_number, x: x, y: y, z: current_z, f: f});
        return gcode_str;
    } else if (line.x === null && line.y !== null && line.g !== null) {
        // Just a y value
        let distance = get_magnitude(last_xy, [last_xy[0], line.y]);
        // let gcode_str = ensure_segmentation_and_z(last_xy, [null, y], already_found, current_z, wear_ratio, g_number, real_f);
        // Update the last y value
        last_xy[1] = line.y;
        current_z -= distance * wear_ratio;
        // let gcode_str = generate_gcode_move(g_number, x, y, current_z, f);
        let new_line = line;
        new_line.z = current_z;
        let gcode_str = move_as_str(new_line);
        // let gcode_str = move_as_str({g: g_number, x: x, y: y, z: current_z, f: f});
        return gcode_str;
    } else if (line.z !== null && line.g !== null) {
        // Just a z value
        // let gcode_str = generate_gcode_move(g_number, x, y, current_z, f);
        // let gcode_str = move_as_str({g: g_number, x: x, y: y, z: current_z, f: f});
        let new_line = line;
        new_line.z = current_z;
        let gcode_str = move_as_str(new_line);
        return gcode_str;
    } else {
        console.log("Found a line that is not a move: \n" + gcode_line);
        let gcode_str = gcode_line + "\n";
        return gcode_str;
    }
}

function get_magnitude(start, end) {
    let diff = [0, 0];
    if (start[0] !== null && start[1] !== null && end[0] !== null && end[1] !== null) {
        diff = [end[0] - start[0], end[1] - start[1]];
    }
    return Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
}

function subdivide_moves(gcode, threshold) {
    // const threshold = 0.1;
    const gcode_lines = gcode.split("\n");
    let last_xy = [null, null];

    let new_gcode = "";
    for (let i = 0; i < gcode_lines.length; i++) {
        let this_line = gcode_lines[i];
        // let this_move_num = move_num(this_line)
        // if (this_line.substring(0, 2) === "G0") {
        //     move_num = 0;
        // } else if (this_line.substring(0, 2) === "G1") {
        //     move_num = 1;
        // }
        let line = parse_move(this_line);
        if (line.g !== null) {
            if (line.x !== null && line.y !== null && last_xy[0] !== null && last_xy[1] !== null) {
                // If there is an x and y value in current line and there was an x and y value in a previous line
                let diff = [line.x - last_xy[0], line.y - last_xy[1]];
                let distance = Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
                if (distance > threshold) {
                    let divided_points = get_points_on_2D_line(last_xy, [line.x, line.y], threshold);
                    console.log(divided_points);
                    for (let i = 0; i < divided_points.length; i++) {
                        let new_line = line;
                        new_line.x = divided_points[i][0];
                        new_line.y = divided_points[i][1];
                        new_gcode += move_as_str(new_line);
                        last_xy = divided_points[i];
                    }
                } else {
                    // If the distance between the two points is less than the threshold, just use the current point
                    new_gcode += move_as_str(line);
                }
            } else if (line.x !== null && line.y === null && last_xy[0] !== null) {
                // if there is an x value in current line and there was an x value in a previous line
                let diff = line.x - last_xy[0];
                let distance = Math.abs(diff);
                if (distance > threshold) {
                    let divided_points = get_points_on_1D_line(last_xy[0], line.x, threshold);
                    for (let i = 0; i < divided_points.length; i++) {
                        let new_line = line;
                        new_line.x = divided_points[i];
                        new_gcode += move_as_str(new_line);
                        last_xy[0] = new_line.x;
                    }
                } else {
                    // If the distance between the two points is less than the threshold, just use the current point
                    new_gcode += move_as_str(line);
                }
            } else if (line.x === null && line.y !== null && last_xy[1] !== null) {
                // if there is a y value in current line and there was a y value in a previous line
                let diff = line.y - last_xy[1];
                let distance = Math.abs(diff);
                if (distance > threshold) {
                    let divided_points = get_points_on_1D_line(last_xy[1], line.y, threshold);
                    for (let i = 0; i < divided_points.length; i++) {
                        let new_line = line;
                        new_line.y = divided_points[i];
                        new_gcode += move_as_str(new_line);
                        last_xy[1] = divided_points[i];
                    }
                } else {
                    // If the distance between the two points is less than the threshold, just use the current point
                    new_gcode += move_as_str(line);
                }
            } else {
                // If there are no x or y values in current line, just add the line
                new_gcode += move_as_str(line);
            }
            if (line.x !== null) {
                // Update last x value if there is one in this line
                last_xy[0] = line.x;
            }
            if (line.y !== null) {
                // Update last y value if there is one in this line
                last_xy[1] = line.y;
            }
        } else {
            // If the line is not a move, just add it to the new gcode
            new_gcode += gcode_lines[i] + "\n";
        }
    }
    return new_gcode;
}

function get_points_on_2D_line(start, end, spacing) {
    let points = [];
    let diff = [end[0] - start[0], end[1] - start[1]];
    let distance = Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
    let num_points = Math.floor(distance / spacing);
    let x_spacing = diff[0] / num_points;
    let y_spacing = diff[1] / num_points;
    for (let i = 0; i < num_points; i++) {
        points.push([start[0] + i * x_spacing, start[1] + i * y_spacing]);
    }
    return points;
}

function get_points_on_1D_line(start, end, spacing) {
    let points = [];
    let diff = end - start;
    let distance = Math.abs(diff);
    let num_points = Math.floor(distance / spacing);
    let spacing_sign = Math.sign(diff);
    for (let i = 0; i < num_points; i++) {
        points.push(start + i * spacing_sign * spacing);
    }
    return points;
}

function update_xy(gcode_line, last_xy) {
    // let has_x = false;
    // let has_y = false;
    let components = gcode_line.split(" ");
    for (let i = 0; i < components.length; i++) {
      if (components[i].substring(0, 1) === "X") {
        let x = parseFloat(components[i].substring(1, components[i].length));
        last_xy[0] = x;
        // has_x = true;
      } else if (components[i].substring(0, 1) === "Y") {
        let y = parseFloat(components[i].substring(1, components[i].length));
        last_xy[1] = y;
        // has_y = true;
      }
    }
    // console.log(last_xy);
}

function parse_move(gcode_line) {
    let line = {g: null, x: null, y: null, z: null, f: null};
    let components = gcode_line.split(" ");
    if (gcode_line.substring(0, 2) === "G0") {
        line.g = 0;
    } else if (gcode_line.substring(0, 2) === "G1") {
        line.g = 1;
    }

    for (let i = 0; i < components.length; i++) {
        if (components[i].substring(0, 1) === "X") {
            line.x = parseFloat(components[i].substring(1, components[i].length));
        } else if (components[i].substring(0, 1) === "Y") {
            line.y = parseFloat(components[i].substring(1, components[i].length));
        } else if (components[i].substring(0, 1) === "Z") {
            line.z = parseFloat(components[i].substring(1, components[i].length));
        } else if (components[i].substring(0, 1) == "F") {
            line.f = parseFloat(components[i].substring(1, components[i].length));
        }
    }
    return line;
}

function move_as_str(move) {
    // console.log(g_num);
    if (move.g === 0 || move.g === 1) {
        const gcode_letters = ["X", "Y", "Z", "F"];
        const gcode_values_str = [move.x, move.y, move.z, move.f];
        let gcode_line = "G" + move.g;
        for (let i = 0; i < gcode_values_str.length; i++) {
            if (gcode_values_str[i] !== null) {
                gcode_line += " " + gcode_letters[i] + gcode_values_str[i];
            }
        }
        gcode_line += "\n";
        return gcode_line;
    } else {
        console.log("ERROR: g_num is not 0 or 1 when passed into move_as_str which is not allowed");
        return "; This gcode line should have been a move but was not\n";
    }
}

// function generate_gcode_move(g_num, x, y, z, f) {
//     // console.log(g_num);
//     if (g_num === 0 || g_num === 1) {
//         const gcode_letters = ["G", "X", "Y", "Z", "F"];
//         const gcode_values_str = [g_num, x, y, z, f];
//         let gcode_line = "";
//         for (let i = 0; i < gcode_values_str.length; i++) {
//             if (gcode_values_str[i] !== null) {
//                 gcode_line += " " + gcode_letters[i] + gcode_values_str[i];
//             }
//         }
//         gcode_line += "\n";
//         return gcode_line;
//     } else {
//         console.log("ERROR: g_num is not 0 or 1 in generate_gcode_move which is not allowed");
//         return "; This gcode line should have been a move but was not\n";
//     }
// }

// function move_num(gcode_line) {
//     // let components = gcode_line.split(" ");
//     if (gcode_line.substring(0, 2) === "G0") {
//         return 0;
//     } else if (gcode_line.substring(0, 2) == "G1") {
//         return 1;
//     } else {
//         return null;
//     }
// }

// function is_move_with_xy(gcode_line) {
//     let components = gcode_line.split(" ");
//     if (gcode_line.substring(0, 2) === "G0" || gcode_line.substring(0, 2) == "G1") {
//         if (components[1].substring(0, 1) === "X") {
//             if (components[2].substring(0, 1) === "Y") {
//                 console.log("Found a gcode move with x and y values");
//                 return true;
//             } else {
//                 return false;
//             }
//         } else {
//             return false;
//         }
//     } else {
//         return false;
//     }
// }

// function ensure_segmentation_and_z(last_xy, this_xy, first_xy_found, current_z, wear_ratio, g_number, f) {
//     const segmentation_threshold = 0.1;
//     let real_point1 = [0, 0];
//     if (this_xy[0] === null) {
//         real_point1[0] = last_xy[0];
//     } else {
//         real_point1[0] = this_xy[0];
//     }
//     if (this_xy[1] === null) {
//         real_point1[1] = last_xy[1];
//     } else {
//         real_point1[1] = this_xy[1];
//     }

//     if (this_xy[0] === null && this_xy[1] === null) {

//     } else if (this_xy[0] === null && this_xy[1] !== null) {
    
//     } else if (this_xy[0] !== null && this_xy[1] === null) {
//         const x_diff = last_xy[0] - real_point1[0];
//         let num_segments = x_diff / segmentation_threshold;
//         if (num_segments > 1) {
//             let gcode_str = "";
//             let seg_last_x = last_xy[0];
//             for (let i = 0; i < num_segments; i++) {
//                 // let distance = get_magnitude([seg_last_xy[0] + segmentation_threshold, seg_last_xy[1]], seg_last_xy, first_xy_found);
//                 seg_last_x += segmentation_threshold;
//                 current_z -= distance * wear_ratio;
//                 gcode_str += generate_gcode_move(g_number, seg_last_xy[0], seg_last_xy[1], current_z, f);
//             }
//             return gcode_str;
//         }
//     }

//     const x_diff = real_point1[0] - last_xy[0];
//     const y_diff = real_point1[1] - last_xy[1];
//     const length = get_magnitude(real_point1, last_xy, first_xy_found);
//     const num_points = length / segmentation_threshold;
//     const x_step = x_diff / num_points;
//     const y_step = y_diff / num_points;
//     let counter = real_point1;
//     let segmented_points = [];
//     for (let i = 0; i < num_points; i++) {
//         segmented_points[i] = counter;
//         counter[0] += x_step;
//         counter[1] += y_step;
//     }
//     let gcode_str = "";
//     let seg_last_xy = real_point1;
//     for (let i = 0; i < segmented_points.length; i++) {
//         let distance = get_magnitude(segmented_points[i], seg_last_xy, first_xy_found);
//         current_z -= distance * wear_ratio;
//         gcode_str += generate_gcode_move(g_number, segmented_points[i][0], segmented_points[i][1], current_z, f);
//         seg_last_xy = segmented_points[i];
//     }
//     last_xy = seg_last_xy;
//     return gcode_str;
// }

// function segment_lines(gcode, segmentation_threshold) {
//     const lines = gcode.split('\n');
//     let segments = [];
//     let current_segment = [];
//     for (let i = 0; i < lines.length; i++) {
//         if (is_move(lines[i]) === 0 || is_move(lines[i]) === 1) {
//             let distance = get_distance(lines[i], lines[i + 1]);
//             current_segment.push(lines[i]);
//         } else {
//             if (current_segment.length > 0) {
//                 segments.push(current_segment);
//                 current_segment = [];
//             }
//         }
//     }
//     return segments;
// }


// function get_xy(gcode_move) {
//     let components = gcode_move.split(" ");
//     const x = parseFloat(components[1].substring(1, components[1].length));
//     const y = parseFloat(components[2].substring(1, components[2].length));
//     return [x, y];
// }

// function update_xy(gcode_line, last_xy) {
//     let x = -999999;
//     let has_x = false;
//     let y = -999999;
//     let has_y = false;
//     let components = gcode_line.split(" ");
//     for (let i = 0; i < components.length; i++) {
//         if (components[i].substring(0, 1) === "X") {
//             x = parseFloat(components[i].substring(1, components[i].length));
//             has_x = true;
//         } else if (components[i].substring(0, 1) === "Y") {
//             y = parseFloat(components[i].substring(1, components[i].length));
//             has_y = true;
//         }
//     }
//     console.log(x, y);
//     if (has_x && has_y) {
//         // return [x, y];
//         last_xy = [x, y];
//     } else if (has_x && !has_y) {
//         last_xy = [x, last_xy[1]];
//         // return [x, last_xy[1]];
//     } else if (!has_x && has_y) {
//         // last_xy = [last_xy[0], y];
//         last_xy[1] = y;
//         // return [last_xy[0], y];
//     } 
// }

