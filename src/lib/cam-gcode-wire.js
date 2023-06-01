'use strict';

import { dist, cut, insideOutside, pocket, reduceCamPaths, separateTabs, vCarve } from './cam';
import { mmToClipperScale, offset, rawPathsToClipperPaths, union } from './mesh';

// Rack Robotics Imports
import { rackRoboPostProcess } from './rack-wire';

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
        // if (op.millEndZ >= op.millStartZ) {
        //     showAlert("millEndZ must be < millStartZ", "danger");
        //     ok = false;
        // }
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
    if (!ok)
        done(false);

    if (tabGeometry && op.toolDiameter > 0)
        tabGeometry = offset(tabGeometry, op.toolDiameter / 2 * mmToClipperScale);

    let camPaths = [];
    if (op.type === 'Virtual Wire EDM Pocket') {
        if (op.margin)
            geometry = offset(geometry, -op.margin * mmToClipperScale);
        camPaths = pocket(geometry, op.toolDiameter * mmToClipperScale, op.stepOver, op.direction === 'Climb');
    } else if (op.type === 'Virtual Wire EDM Cut') {
        camPaths = cut(geometry, openGeometry, op.direction === 'Climb');
    } else if (op.type === 'Virtual Wire EDM Cut Inside') {
        if (op.margin)
            geometry = offset(geometry, -op.margin * mmToClipperScale);
        camPaths = insideOutside(geometry, op.toolDiameter * mmToClipperScale, true, op.cutWidth * mmToClipperScale, op.stepOver, op.direction === 'Climb', true);
    } else if (op.type === 'Virtual Wire EDM Cut Outside') {
        if (op.margin)
            geometry = offset(geometry, op.margin * mmToClipperScale);
        camPaths = insideOutside(geometry, op.toolDiameter * mmToClipperScale, false, op.cutWidth * mmToClipperScale, op.stepOver, op.direction === 'Climb', true);
    } else if (op.type === 'Virtual Wire EDM V Carve') {
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
        "\r\n; Operation:     " + opIndex +
        "\r\n; Type:          " + op.type +
        "\r\n; Paths:         " + camPaths.length +
        // "\r\n; Direction:     " + op.direction +
        "\r\n; Rapid Z:       " + op.millRapidZ +
        "\r\n; Start Z:       " + op.millStartZ +
        // "\r\n; End Z:         " + op.millEndZ +
        // "\r\n; Pass Depth:    " + op.passDepth +
        "\r\n; Cut Start Z:   " + op.cutStartZ +
        "\r\n; Plunge rate:   " + op.plungeRate + ' ' + settings.toolFeedUnits +
        "\r\n; Cut rate:      " + op.cutRate + ' ' + settings.toolFeedUnits +
        "\r\n; Travel Speed:  " + op.travelSpeed + ' ' + settings.toolFeedUnits +
        "\r\n; Tool Diameter: " + op.toolDiameter +
        "\r\n; Wear Ratio:    " + op.wearRatio +
        "\r\n;\r\n";

    if (op.hookOperationStart.length) gcode += op.hookOperationStart;

    // console.log(typeof op.ramp);
    gcode += getWireGcode({
        paths: camPaths,
        ramp: false,
        scale: 1 / mmToClipperScale,
        useZ: op.type === 'Mill V Carve',
        offsetX: 0,
        offsetY: 0,
        decimal: 3,
        topZ: op.millStartZ,
        // botZ: op.millEndZ,
        // botZ: -op.passDepth,
        botZ: op.cutStartZ,
        safeZ: op.millRapidZ,
        // passDepth: op.passDepth,
        passDepth: -op.cutStartZ,
        plungeFeed: op.plungeRate * feedScale,
        cutFeed: op.cutRate * feedScale,
        tabGeometry: op.type === 'Mill V Carve' ? [] : tabGeometry,
        tabZ: -op.tabDepth,
        toolSpeed: 0,
    });

    if (op.hookOperationEnd.length) gcode += op.hookOperationEnd;

    // let post_processed = rackGcodePostProcess(gcode, op.wearRatio, op.plungeRate, op.millStartZ, op.millRapidZ);
    // let post_processed = rackRoboPostProcess(gcode, op.wearRatio, op.plungeRate, op.millStartZ, op.millRapidZ, -op.passDepth, op.travelSpeed);
    let post_processed = rackRoboPostProcess(gcode, op.wearRatio, op.plungeRate, op.millStartZ, op.millRapidZ, op.cutStartZ, op.travelSpeed);
    done(post_processed)
    // done(gcode)

} // getWireGcodeFromOp

function rackGcodePostProcess(gcode, wear_ratio, plunge_feed_rate, start_z, rapid_z) {
    console.log("Original Gcode: \n", gcode);
    // let cuts = find_cuts(gcode);
    // console.log("Cuts: \n", cuts.cut_blocks);
    // console.log("The rest: \n", cuts.the_rest);
    // let subdiv_cuts = subdivide_cuts(cuts.cut_blocks, 0.1);
    // console.log("Subdivided Cuts: \n", subdiv_cuts);
    // let plunges_new = find_plunges_cuts_removed(cuts.the_rest);
    // console.log("Plunges: \n", plunges_new.plunges);
    // console.log("Plunges Removed: \n", plunges_new.the_rest);
    let plunge = find_plunges(gcode, plunge_feed_rate);
    // console.log("Plunges: \n", plunge.gcode);
    let retract = find_and_remove_retracts(gcode, start_z, rapid_z);
    // console.log("Retracts Removed: \n", retract.retracts_removed);
    // console.log("Retracts: \n", retract.retracts);
    let subdivided = subdivide_moves(retract.retracts_removed, 0.1);
    // console.log("Subdivided: \n", subdivided);
    let z_added = add_z(subdivided, wear_ratio);
    // console.log("Z Added: \n", z_added);
    let retracts_added = add_back_retracts(z_added, retract.retracts);
    // console.log("Retracts added back: \n", retracts_added);
    let plunges_added = add_plunges(retracts_added, plunge.gcode);
    // console.log("Plunges added to top: \n", plunges_added);
    test_proper_z(plunges_added, retract.count);
    return plunges_added;
}

// function find_cuts(gcode) {
//     let cut_blocks = [];
//     let gcode_lines = gcode.split('\n');
//     let in_cut = false;
//     let cut_block = "";
//     let the_rest = "";
//     let cut_block_counter = 0;
//     for (let i = 0; i < gcode_lines.length; i++) {
//         if (gcode_lines[i].substring(0, 5) === "; cut") {
//             if (in_cut) {
//                 cut_blocks.push(cut_block);
//                 cut_block_counter++;
//                 the_rest += "; add cut " + cut_block_counter + "\n";
//                 cut_block = "";
//                 cut_block += gcode_lines[i] + "\n";
//             } else {
//                 in_cut = true;
//                 cut_block += gcode_lines[i] + "\n";
//             }
//         } else if (gcode_lines[i].substring(0, 1) === ";") {
//             if (in_cut) {
//                 cut_blocks.push(cut_block);
//                 cut_block_counter++;
//                 the_rest += "; add cut " + cut_block_counter + "\n";
//                 cut_block = "";
//                 in_cut = false;
//             }
//             the_rest += gcode_lines[i] + "\n";
//         } else {
//             if (in_cut) {
//                 cut_block += gcode_lines[i] + "\n";
//             } else {
//                 the_rest += gcode_lines[i] + "\n";
//             }
//         }
//     }
//     return {cut_blocks: cut_blocks, the_rest: the_rest};
// }

// function find_plunges_cuts_removed(gcode) {
//     let gcode_lines = gcode.split('\n');

//     let retract_counter = 0;
//     let plunges = [];
//     let the_rest = "";
//     let lines_to_retract_end = 0;
//     for (let i = 0; i < gcode_lines.length; i++) {
//         if (gcode_lines[i].substring(0, 9) === "; Retract") {
//             let plunge = "";
//             the_rest += "; add plunge " + retract_counter + "\n";
//             plunge += gcode_lines[i] + "\n";
//             plunge += gcode_lines[i + 1] + "\n";
//             if (gcode_lines[i + 2] !== undefined) {
//                 plunge += gcode_lines[i + 2] + "\n";
//             }
//             if (gcode_lines[i + 3] !== undefined) {
//                 plunge += gcode_lines[i + 3] + "\n";
//             }
//             if (gcode_lines[i + 4] !== undefined) {
//                 plunge += gcode_lines[i + 4] + "\n";
//             }
//             if (gcode_lines[i + 5] !== undefined) {
//                 plunge += gcode_lines[i + 5] + "\n";
//             }
//             if (gcode_lines[i + 6] !== undefined) {
//                 plunge += gcode_lines[i + 6] + "\n";
//             }
//             if (gcode_lines[i + 7] !== undefined) {
//                 plunge += gcode_lines[i + 7] + "\n";
//             }
//             if (gcode_lines[i + 8] !== undefined) {
//                 plunge += gcode_lines[i + 8] + "\n";
//             }
//             plunges.push(plunge);
//             retract_counter++;
//             lines_to_retract_end = 8;
//         } else {
//             if (lines_to_retract_end === 0) {
//                 the_rest += gcode_lines[i] + "\n";
//             } else {
//                 lines_to_retract_end--;
//             }
//         }
//     }
//     return {plunges: plunges, the_rest: the_rest};
// }

// function subdivide_cuts(cut_blocks, threshold) {
//     let subdivided = [];
//     for (let i = 0; i < cut_blocks.length; i++) {
//         const gcode_lines = cut_blocks[i].split("\n");
//         // let last_xy = [null, null];

//         let new_gcode = "";
//         for (let j = 0; j < gcode_lines.length; j++) {
//             // let this_line = gcode_lines[i];
//             let line = parse_move(gcode_lines[j]);
//             let next_xy = get_next_xy(cut_blocks[i], j);
//             // console.log("Next XY: ", next_xy);
//             // For the last line, the next_xy will be null
//             if (next_xy[0] === null || next_xy[1] === null) {
//                 new_gcode += gcode_lines[j] + "\n";
//                 break;
//             }
//             if (line.g === null) {
//                 // If the line is not a move, just add it to the new gcode
//                 new_gcode += gcode_lines[j] + "\n";
//             } else {
//                 if (line.x !== null) {
//                     if (line.y !== null) {
//                         // console.log("Found a line with x and y");
//                         // If there is an x and y value in current line and there was an x and y value in a previous line
//                         let diff = [line.x - next_xy[0], line.y - next_xy[1]];
//                         let distance = Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
//                         if (distance > threshold) {
//                             // console.log("Distance is greater than threshold");
//                             let divided_points = get_points_on_2D_line([line.x, line.y], next_xy, threshold);
//                             // log_array_of_arrays(divided_points, "divided_points");
//                             for (let k = 0; k < divided_points.length; k++) {
//                                 let new_line = line;
//                                 new_line.x = divided_points[k][0];
//                                 new_line.y = divided_points[k][1];
//                                 new_gcode += move_as_str(new_line);
//                                 // last_xy = divided_points[i];
//                             }
//                             // last_xy = divided_points[divided_points.length - 1];
//                         } else {
//                             // If the distance between the two points is less than the threshold, just use the current point
//                             // last_xy = [line.x, line.y];
//                             new_gcode += move_as_str(line);
//                         }
//                     } else {
//                         let diff = line.x - next_xy[0];
//                         let distance = Math.abs(diff);
//                         if (distance > threshold) {
//                             let divided_points = get_points_on_1D_line(next_xy[0], line.x, threshold);
//                             for (let k = 0; k < divided_points.length - 1; k++) {
//                                 let new_line = line;
//                                 new_line.x = divided_points[k];
//                                 new_gcode += move_as_str(new_line);
//                                 // last_xy[0] = new_line.x;
//                             }
//                             // last_xy[0] = divided_points[divided_points.length - 1];
//                         } else {
//                             // If the distance between the two points is less than the threshold, just use the current point
//                             // last_xy[0] = line.x;
//                             new_gcode += move_as_str(line);
//                         }
//                     }
//                 } else {
//                     if (line.y !== null) {
//                         let diff = line.y - next_xy[1];
//                         let distance = Math.abs(diff);
//                         if (distance > threshold) {
//                             let divided_points = get_points_on_1D_line(next_xy[1], line.y, threshold);
//                             for (let k = 0; k < divided_points.length - 1; k++) {
//                                 let new_line = line;
//                                 new_line.y = divided_points[k];
//                                 new_gcode += move_as_str(new_line);
//                                 // last_xy[1] = new_line.y;
//                             }
//                             // last_xy[1] = divided_points[divided_points.length - 1];
//                         } else {
//                             // If the distance between the two points is less than the threshold, just use the current point
//                             // last_xy[1] = line.y;
//                             new_gcode += move_as_str(line);
//                         }
//                     } else {
//                         // This is for the case when we detect a move command but there is no x or y value
//                         new_gcode += move_as_str(line);
//                     }
//                 }
//             }
//         }
//         subdivided.push(new_gcode);
//     }
//     // console.log("Original gcode length: " + gcode.length);
//     // console.log("New gcode length: " + new_gcode.length);
//     return subdivided;
// }

function find_plunges(gcode, plunge_feed_rate) {
    console.log("Plunge Feed: ", plunge_feed_rate);
    const plunge_retract_dist = 5.0;
    const plunge_depth = -1.0;
    const plunge_travel_speed = 100;
    const plunge_initiation_string = "; plunge";
    const lines = gcode.split('\n');

    let plunges = "";
    let last_point = [0, 0];
    let plunge_counter = 1;
    // let plunges_removed = "";
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].substring(0, 8) === "; plunge") {
            let plunge_text = "";
            console.log("Found a plunge");
            plunge_text += lines[i - 7] + "\n";
            plunge_text += lines[i - 6] + "\n";
            plunge_text += lines[i - 5] + "\n";
            plunge_text += lines[i - 4] + "\n";
            plunge_text += lines[i - 3] + "\n";
            plunge_text += lines[i - 2] + "\n";
            plunge_text += lines[i - 1] + "\n";
            plunge_text += lines[i] + "\n";
            plunge_text += lines[i + 1] + "\n";
            // let plunge_retract = parse_move(lines[i + 1]);
            // plunge_text += "; Retract\n";
            // plunge_text += move_as_str({g: 0, x: null, y: null, z: plunge_retract.z, f: plunge_feed_rate}) + "\n";
            // let path_num = parseInt(lines[i + 3].substring(7, 8))
            // if (path_num === undefined) {

            // } else {
            //     plunge_text += "; Path " + path_num + "\n";
            // }
            // plunge_text += "; plunge " + plunge_counter + "\n";
            // plunge_text += move_as_str({g: 1, x: null, y: null, z: plunge_retract_dist, f: plunge_feed_rate});
            // Move to plunge start
            // plunge_text += move_as_str({g: 1, x: last_point[0], y: last_point[1], z: null, f: plunge_travel_speed});
            // Do plunge
            // plunge_text += move_as_str({g: 1, x: null, y: null, z: plunge_depth, f: plunge_feed_rate}) + "\n";
            plunges += plunge_text;
            plunge_counter++;
        } 
        update_xy(lines[i], last_point);
    }
    return {gcode: plunges, count: plunge_counter - 1};
}

function add_plunges(gcode, plunges) {
    let plunges_added = "";
    let plunges_added_back = false;
    // const line_to_add_plunges_before = "; Path 0 \n";
    const line_to_add_plunges_after = "; Wear Ratio:";
    let gcode_lines = gcode.split('\n');
    for (let i = 0; i < gcode_lines.length; i++) {
        if (gcode_lines[i].substring(0, 13) === line_to_add_plunges_after.substring(0, 13)) {
            console.log("Found the Wear Ratio line");
            if (!plunges_added_back) {
                plunges_added += gcode_lines[i] + "\n";
                plunges_added += plunges + "\n";
                plunges_added_back = true;
            } else {
                console.log("MAJOR ERROR: Found the Path 0 line twice");
                plunges_added += gcode_lines[i] + "\n";
            }
        } else {
            plunges_added += gcode_lines[i] + "\n";
        }
    }
    return plunges_added;
}

// function find_and_remove_plunges(gcode, plunge_feed_rate) {
//     console.log("Plunge Feed: ", plunge_feed_rate);
//     const plunge_retract_dist = 5.0;
//     const plunge_depth = -1.0;
//     const plunge_travel_speed = 100;
//     const plunge_initiation_string = "; plunge";
//     const lines = gcode.split('\n');

//     let plunges = [];
//     let last_point = [0, 0];
//     let plunge_counter = 0;
//     let plunges_removed = [];
//     let lines_since_last_plunge = 100;
//     for (let i = 0; i < lines.length; i++) {
//         if (lines[i].substring(0, 8) === plunge_initiation_string) {
//             plunges_removed.pop();
//             plunges_removed.push("; add plunge " + plunge_counter + " here\n")
//             let plunge_text = "";
//             console.log("Found a plunge");
//             // Retract
//             plunge_text += "; plunge " + plunge_counter + "\n";
//             plunge_text += move_as_str({g: 1, x: null, y: null, z: plunge_retract_dist, f: plunge_feed_rate});
//             // Move to plunge start
//             plunge_text += move_as_str({g: 1, x: last_point[0], y: last_point[1], z: null, f: plunge_travel_speed});
//             // Do plunge
//             plunge_text += move_as_str({g: 1, x: null, y: null, z: plunge_depth, f: plunge_feed_rate}) + "\n";
//             plunges.push(plunge_text);
//             lines_since_last_plunge = 0;
//             plunge_counter++;
//         } else if (lines_since_last_plunge < 1) {
//             lines_since_last_plunge++;
//             continue;
//         } else {
//             plunges_removed.push(lines[i] + "\n");
//         }
//         update_xy(lines[i], last_point);
//     }
//     let plunges_removed_str = "";
//     for (let i = 0; i < plunges_removed.length; i++) {
//         plunges_removed_str += plunges_removed[i];
//     }
//     return {plunges: plunges, plunges_removed: plunges_removed_str, count: plunge_counter};
// }
function find_and_remove_retracts(gcode, start_z, rapid_z) {
    // console.log("Plunge Feed: ", plunge_feed_rate);
    // const plunge_retract_dist = 5.0;
    // const plunge_depth = -1.0;
    // const plunge_travel_speed = 100;
    // const retract_initiation_string = "; Retract";
    const lines = gcode.split('\n');

    let retracts = [];
    let last_point = [0, 0];
    let retracts_counter = 0;
    let retracts_removed = [];
    let lines_since_last_retract = 100;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].substring(0, 9) === "; Retract") {
            // retracts_removed.pop();
            retracts_removed.push("; add retract " + retracts_counter + "\n")
            let retract_text = "";
            console.log("Found a retract");
            // Retract
            retract_text += "; Retract " + retracts_counter + "\n";
            // retract_text += move_as_str({g: 0, x: null, y: null, z: rapid_z, f: null});
            retract_text += lines[i + 1] + "\n";
            retract_text += lines[i + 2] + "\n";
            retract_text += lines[i + 3] + "\n";
            retract_text += lines[i + 4] + "\n";
            retract_text += lines[i + 5] + "\n";
            retract_text += lines[i + 6] + "\n";
            retracts.push(retract_text);
            lines_since_last_retract = 0;
            retracts_counter++;
        } else if (lines_since_last_retract < 6) {
            lines_since_last_retract++;
            continue;
        } else {
            retracts_removed.push(lines[i] + "\n");
        }
        update_xy(lines[i], last_point);
    }
    let retracts_removed_str = "";
    for (let i = 0; i < retracts_removed.length; i++) {
        retracts_removed_str += retracts_removed[i];
    }
    return {retracts: retracts, retracts_removed: retracts_removed_str, count: retracts_counter};
}

      // } else if (lines[i].substring(0, 8) === "; plunge") {
        //     retracts_removed.pop();
        //     // let plunge_retract_num = parse_move(plunge_retract).z;
        //     retracts_removed.push("; add retract " + retracts_counter + "\n");
        //     retracts_removed.push("; plunge \n")
        //     let retract_text = move_as_str({g: 0, x: null, y: null, z: start_z, f: null});
        //     console.log("Found a retract");
        //     // Retract
        //     retracts.push(retract_text);
        //     retracts_counter++;

function add_back_retracts(gcode, retracts) {
    const lines = gcode.split('\n');
    let new_gcode = "";
    // let retracts_counter = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].substring(0, 14) === ("; add retract ")) {
            let retract_num = parseInt(lines[i].substring(14, lines[i].length));
            new_gcode += retracts[retract_num];
            // retracts_counter++;
        } else {
            new_gcode += lines[i] + "\n";
        }
    }
    return new_gcode;
}

function add_z(gcode, wear_ratio) {
    let last_xy = [null, null];
    let lines = gcode.split('\n');
    let current_z = 0;
    let files_current_z = 0;

    let new_gcode = "";
    for (let i = 0; i < lines.length; i++) {
        let corrected = correct_line(lines[i], wear_ratio, last_xy, current_z, files_current_z);
        new_gcode += corrected.gcode;
        current_z += corrected.z_update;
        files_current_z += corrected.files_z_update;
    }
    return new_gcode;
}

// files_current_z is telling us where the file thinks the z is
function correct_line(gcode_line, wear_ratio, last_xy, current_z, files_current_z) {
    let line = parse_move(gcode_line);
    // if (last_xy[0] === null || last_xy[1] === null) {
    //     let update_files_z = 0;
    //     if (line.z !== null) {
    //         update_files_z = line.z - files_current_z;
    //     }
    //     let z_update = update_files_z;
    //     let new_line = line;
    //     new_line.z = current_z + z_update;
    //     update_xy(gcode_line, last_xy);
    //     return {gcode: move_as_str(new_line), z_update: z_update, files_z_update: update_files_z};
    // } else {
    if (line.g !== null) {
        if (line.x !== null) {
            if (line.y !== null) {
                // Has x and y values
                let update_files_z = 0;
                if (line.z !== null) {
                    update_files_z = line.z - files_current_z;
                }
                let distance = get_magnitude(last_xy, [line.x, line.y]);
                last_xy[0] = line.x;
                last_xy[1] = line.y;
                let z_update = -(distance * wear_ratio) + update_files_z;
                // current_z -= distance * wear_ratio;
                let new_line = line;
                new_line.z = current_z + z_update;
                // update_xy(gcode_line, last_xy);
                // let gcode_str = move_as_str(new_line);
                return {gcode: move_as_str(new_line), z_update: z_update, files_z_update: update_files_z};
            } else {
                let update_files_z = 0;
                if (line.z !== null) {
                    update_files_z = line.z - files_current_z;
                }
                let distance = get_magnitude(last_xy, [line.x, last_xy[1]]);
                last_xy[0] = line.x;
                let z_update = -(distance * wear_ratio) + update_files_z;
                // current_z -= distance * wear_ratio;
                let new_line = line;
                new_line.z = current_z + z_update;
                // return {gcode: move_as_str(new_line), new_z: current_z};
                update_xy(gcode_line, last_xy);
                return {gcode: move_as_str(new_line), z_update: z_update, files_z_update: update_files_z};
            }
        } else {
            if (line.y !== null) {
                let update_files_z = 0;
                if (line.z !== null) {
                    update_files_z = line.z - files_current_z;
                }
                let distance = get_magnitude(last_xy, [last_xy[0], line.y]);
                last_xy[1] = line.y;
                let z_update = -(distance * wear_ratio) + update_files_z;
                // current_z -= distance * wear_ratio;
                let new_line = line;
                new_line.z = current_z + z_update;
                // return {gcode: move_as_str(new_line), new_z: current_z};
                update_xy(gcode_line, last_xy);
                return {gcode: move_as_str(new_line), z_update: z_update, files_z_update: update_files_z};
            } else {
                let update_files_z = 0;
                if (line.z !== null) {
                    update_files_z = line.z - files_current_z;
                }
                let new_line = line;
                let z_update = update_files_z;
                new_line.z = current_z + z_update;
                // return {gcode: move_as_str(new_line), new_z: current_z};
                update_xy(gcode_line, last_xy);
                return {gcode: move_as_str(new_line), z_update: z_update, files_z_update: update_files_z};
            }
        }
    } else {
        // Not a move
        let gcode_str = gcode_line + "\n";
        return {gcode: gcode_str, z_update: 0, files_z_update: 0};
    }
    // }
}

function get_magnitude(start, end) {
    let diff = [0, 0];
    if (start[0] !== null && start[1] !== null && end[0] !== null && end[1] !== null) {
        diff = [end[0] - start[0], end[1] - start[1]];
    }
    return Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
}

function log_array_of_arrays(arr, header) {
    console.log(header);
    for (let i = 0; i < arr.length; i++) {
        let this_arr_str = "[";
        for (let j = 0; j < arr[i].length; j++) {
            if (j > arr[i].length - 2) {
                this_arr_str += arr[i][j];
            } else {
                this_arr_str += arr[i][j] + ", ";
            }
        }
        this_arr_str += "]";
        console.log(this_arr_str);
    }
}

function get_next_xy(gcode, start_index) {
    let lines = gcode.split('\n');
    let next_xy = [null, null];
    for (let i = (start_index + 1); i < lines.length - 1; i++) {
        let line = parse_move(lines[i]);
        if (line.g !== null) {
            if (line.x !== null && next_xy[0] === null) {
                next_xy[0] = line.x;
            }
            if (line.y !== null && next_xy[1] === null) {
                next_xy[1] = line.y;
            }
            if (next_xy[0] !== null && next_xy[1] !== null) {
                return next_xy;
            }
        }
    }
    if (next_xy[0] === undefined) {
        next_xy[0] = null;
    }
    if (next_xy[1] === undefined) {
        next_xy[1] = null;
    }
    return next_xy;
}

function subdivide_moves(gcode, threshold) {
    const gcode_lines = gcode.split("\n");
    // let last_xy = [null, null];

    let new_gcode = "";
    for (let i = 0; i < gcode_lines.length; i++) {
        // let this_line = gcode_lines[i];
        let line = parse_move(gcode_lines[i]);
        // console.log("line: " + JSON.stringify(line));
        let next_xy = get_next_xy(gcode, i);
        if (next_xy[0] === null || next_xy[1] === null) {
            new_gcode += gcode_lines[i] + "\n";
            break;
        }
        // if (i > gcode_lines.length - 2) {
        //     // If there is no next x or y value, then just pass the line through
        //     new_gcode += gcode_lines[i] + "\n";
        //     break;
        // } else {
        //     next_xy = get_next_xy(gcode, i);
        // }
        // console.log("next_xy: " + JSON.stringify(next_xy));
        if (line.g !== null) {
            if (line.x !== null) {
                if (line.y !== null) {
                    // If there is an x and y value in current line and there was an x and y value in a previous line
                    // let diff = [line.x - last_xy[0], line.y - last_xy[1]];
                    let diff = [line.x - next_xy[0], line.y - next_xy[1]];
                    let distance = Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
                    if (distance > threshold) {
                        let divided_points = get_points_on_2D_line([line.x, line.y], next_xy, threshold);
                        // log_array_of_arrays(divided_points, "divided_points");
                        for (let i = 0; i < divided_points.length; i++) {
                            let new_line = line;
                            new_line.x = divided_points[i][0];
                            new_line.y = divided_points[i][1];
                            new_gcode += move_as_str(new_line);
                            // last_xy = divided_points[i];
                        }
                        // last_xy = divided_points[divided_points.length - 1];
                    } else {
                        // If the distance between the two points is less than the threshold, just use the current point
                        // last_xy = [line.x, line.y];
                        new_gcode += move_as_str(line);
                    }
                } else {
                    let diff = line.x - next_xy[0];
                    let distance = Math.abs(diff);
                    if (distance > threshold) {
                        let divided_points = get_points_on_1D_line(next_xy[0], line.x, threshold);
                        for (let i = 0; i < divided_points.length - 1; i++) {
                            let new_line = line;
                            new_line.x = divided_points[i];
                            new_gcode += move_as_str(new_line);
                            // last_xy[0] = new_line.x;
                        }
                        // last_xy[0] = divided_points[divided_points.length - 1];
                    } else {
                        // If the distance between the two points is less than the threshold, just use the current point
                        // last_xy[0] = line.x;
                        new_gcode += move_as_str(line);
                    }
                }
            } else {
                if (line.y !== null) {
                    let diff = line.y - next_xy[1];
                    let distance = Math.abs(diff);
                    if (distance > threshold) {
                        let divided_points = get_points_on_1D_line(next_xy[1], line.y, threshold);
                        for (let i = 0; i < divided_points.length - 1; i++) {
                            let new_line = line;
                            new_line.y = divided_points[i];
                            new_gcode += move_as_str(new_line);
                            // last_xy[1] = new_line.y;
                        }
                        // last_xy[1] = divided_points[divided_points.length - 1];
                    } else {
                        // If the distance between the two points is less than the threshold, just use the current point
                        // last_xy[1] = line.y;
                        new_gcode += move_as_str(line);
                    }
                } else {
                    // This is for the case when we detect a move command but there is no x or y value
                    new_gcode += move_as_str(line);
                }
            }
            // } else {
            //     // These two ifs are to lead the first found x and y values
            //     if (line.x !== null) {
            //         // Update last x value if there is one in this line
            //         last_xy[0] = line.x;
            //     }
            //     if (line.y !== null) {
            //         // Update last y value if there is one in this line
            //         last_xy[1] = line.y;
            //     }
            // }
        } else {
            // If the line is not a move, just add it to the new gcode
            new_gcode += gcode_lines[i] + "\n";
        }
    }
    console.log("Original gcode length: " + gcode.length);
    console.log("New gcode length: " + new_gcode.length);
    return new_gcode;
}

// function subdivide_moves(gcode, threshold) {
//     const gcode_lines = gcode.split("\n");
//     let last_xy = [null, null];

//     let new_gcode = "";
//     for (let i = 0; i < gcode_lines.length; i++) {
//         // let this_line = gcode_lines[i];
//         let line = parse_move(gcode_lines[i]);
//         let next_xy = get_next_xy(gcode, i);
//         if (line.g !== null) {
//             if (last_xy[0] !== null && last_xy[1] !== null) {
//                 if (line.x !== null) {
//                     if (line.y !== null) {
//                         // If there is an x and y value in current line and there was an x and y value in a previous line
//                         // let diff = [line.x - last_xy[0], line.y - last_xy[1]];
//                         let diff = [line.x - next_xy[0], line.y - next_xy[1]];
//                         let distance = Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
//                         if (distance > threshold) {
//                             let divided_points = get_points_on_2D_line([line.x, line.y], next_xy, threshold);
//                             log_array_of_arrays(divided_points, "divided_points");
//                             for (let i = 0; i < divided_points.length - 1; i++) {
//                                 let new_line = line;
//                                 new_line.x = divided_points[i][0];
//                                 new_line.y = divided_points[i][1];
//                                 new_gcode += move_as_str(new_line);
//                                 // last_xy = divided_points[i];
//                             }
//                             last_xy = divided_points[divided_points.length - 1];
//                         } else {
//                             // If the distance between the two points is less than the threshold, just use the current point
//                             // last_xy = [line.x, line.y];
//                             new_gcode += move_as_str(line);
//                         }
//                     } else {
//                         let diff = line.x - last_xy[0];
//                         let distance = Math.abs(diff);
//                         if (distance > threshold) {
//                             let divided_points = get_points_on_1D_line(last_xy[0], line.x, threshold);
//                             for (let i = 0; i < divided_points.length; i++) {
//                                 let new_line = line;
//                                 new_line.x = divided_points[i];
//                                 new_gcode += move_as_str(new_line);
//                                 // last_xy[0] = new_line.x;
//                             }
//                             last_xy[0] = divided_points[divided_points.length - 1];
//                         } else {
//                             // If the distance between the two points is less than the threshold, just use the current point
//                             last_xy[0] = line.x;
//                             new_gcode += move_as_str(line);
//                         }
//                     }
//                 } else {
//                     if (line.y !== null) {
//                         let diff = line.y - last_xy[1];
//                         let distance = Math.abs(diff);
//                         if (distance > threshold) {
//                             let divided_points = get_points_on_1D_line(last_xy[1], line.y, threshold);
//                             for (let i = 0; i < divided_points.length; i++) {
//                                 let new_line = line;
//                                 new_line.y = divided_points[i];
//                                 new_gcode += move_as_str(new_line);
//                                 // last_xy[1] = new_line.y;
//                             }
//                             last_xy[1] = divided_points[divided_points.length - 1];
//                         } else {
//                             // If the distance between the two points is less than the threshold, just use the current point
//                             last_xy[1] = line.y;
//                             new_gcode += move_as_str(line);
//                         }
//                     } else {
//                         // This is for the case when we detect a move command but there is no x or y value
//                         new_gcode += move_as_str(line);
//                     }
//                 }
//                 // } else if (line.x !== null && line.y === null && last_xy[0] !== null) {
//                 //     // if there is an x value in current line and there was an x value in a previous line
//                 //     let diff = line.x - last_xy[0];
//                 //     let distance = Math.abs(diff);
//                 //     if (distance > threshold) {
//                 //         let divided_points = get_points_on_1D_line(last_xy[0], line.x, threshold);
//                 //         for (let i = 0; i < divided_points.length; i++) {
//                 //             let new_line = line;
//                 //             new_line.x = divided_points[i];
//                 //             new_gcode += move_as_str(new_line);
//                 //             last_xy[0] = new_line.x;
//                 //         }
//                 //     } else {
//                 //         // If the distance between the two points is less than the threshold, just use the current point
//                 //         new_gcode += move_as_str(line);
//                 //     }
//                 // } else if (line.x === null && line.y !== null && last_xy[1] !== null) {
//                 //     // if there is a y value in current line and there was a y value in a previous line
//                 //     let diff = line.y - last_xy[1];
//                 //     let distance = Math.abs(diff);
//                 //     if (distance > threshold) {
//                 //         let divided_points = get_points_on_1D_line(last_xy[1], line.y, threshold);
//                 //         for (let i = 0; i < divided_points.length; i++) {
//                 //             let new_line = line;
//                 //             new_line.y = divided_points[i];
//                 //             new_gcode += move_as_str(new_line);
//                 //             last_xy[1] = divided_points[i];
//                 //         }
//                 //     } else {
//                 //         // If the distance between the two points is less than the threshold, just use the current point
//                 //         new_gcode += move_as_str(line);
//                 //     }
//                 // } else {
//                 //     // If there are no x or y values in current line, just add the line
//                 //     new_gcode += move_as_str(line);
//                 // }
//             } else {
//                 // These two ifs are to lead the first found x and y values
//                 if (line.x !== null) {
//                     // Update last x value if there is one in this line
//                     last_xy[0] = line.x;
//                 }
//                 if (line.y !== null) {
//                     // Update last y value if there is one in this line
//                     last_xy[1] = line.y;
//                 }
//             }
//         } else {
//             // If the line is not a move, just add it to the new gcode
//             new_gcode += gcode_lines[i] + "\n";
//         }
//     }
//     console.log("Original gcode length: " + gcode.length);
//     console.log("New gcode length: " + new_gcode.length);
//     return new_gcode;
// }
function test_proper_z(gcode) {
    let gcode_lines = gcode.split("\n");
    let error_message_count = 0;
    let in_main_gcode = false;
    for (let i = 1; i < gcode_lines.length; i++) {
        if (gcode_lines[i - 1].includes("; Rapid to initial position")) {
            in_main_gcode = true;
        }
        let line = parse_move(gcode_lines[i]);
        let last_line = parse_move(gcode_lines[i - 1]);
        if (in_main_gcode) {
            if ((line.g === 0 || line.g === 1) && (last_line.g === 0 || last_line.g === 1)) {
                if (line.z === null || last_line.z === null) {
                    console.log("ERROR: z value is null in gcode line " + i + " which is not allowed");
                } else if (line.z > last_line.z) {
                    if (error_message_count < 50) {
                        console.log("ERROR: z value (" + line.z + ") is greater than the previous z value (" + last_line.z + ") in gcode line " + i + " which should not happen except for retracts");
                    }
                    error_message_count++;
                }
            }
        }
    }
    if (error_message_count === 0) {
        console.log("All z values are less than than previous z values");
    } else if (error_message_count > 50) {
        console.log("ERROR: There were " + error_message_count + " errors of z value not being greater than previous z value");
    }
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
    // console.log("2D points found on line: " + points);
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
    let line = parse_move(gcode_line);

    if (line.x !== null) {
        last_xy[0] = line.x;
    } 
    if (line.y !== null) {
        last_xy[1] = line.y;
    }
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
    if (move.g === 0 || move.g === 1) {
        const gcode_letters = ["X", "Y", "Z", "F"];
        const gcode_values_str = [move.x, move.y, move.z, move.f];
        let gcode_line = "G" + move.g;
        for (let i = 0; i < gcode_values_str.length; i++) {
            if (gcode_values_str[i] !== null) {
                gcode_line += " " + gcode_letters[i] + gcode_values_str[i].toFixed(3);
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

