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

    // checkVariableType(gcode);

    // console.log(gcode);

    let post_processed = rackGcodePostProcess(gcode, op.wearRatio);
    // done(gcode)
    done(post_processed)

} // getWireGcodeFromOp

function rackGcodePostProcess(gcode, wear_ratio) {
    console.log("Original Gcode: \n", gcode);
    const critcal_distance_threshold_for_segmentation = 0.05;
    
    const rapid_feedrate_for_G0_commands = 1200;
    let plunges_reordered = findAndReorderPlunges(gcode);
    let new_gcode = "We are in the gcode processing pipeline\n";
    // Split the gcode string into an array of lines
    const lines = plunges_reordered.split('\n');
  
    // Iterate through each line in the array
    for (let i = 0; i < lines.length; i++) {
        // Print the current line to the console
        // console.log(lines[i]);
        new_gcode += lines[i] + "\n";
    }
    console.log(new_gcode);
    return new_gcode
}

function findAndReorderPlunges(gcode) {
    const plunge_initiation_string = "; plunge";
    const lines = gcode.split('\n');

    let plunges = "";
    let last_line_was_plunge = false;
    let plunges_removed = "";
    let last_xy = [0, 0];
    for (let i = 0; i < lines.length; i++) {
        
        // console.log("Processing Line");
        // console.log(lines[i]);
        if (lines[i].substring(0, 8) === plunge_initiation_string) {
            console.log("Found a plunge");
            plunges += "G0 Z1.0\n" + "G0 X" + last_xy[0] + " Y" + last_xy[1] + "\n";
            plunges += lines[i] + "\n" + lines[i + 1] + "\n";
            last_line_was_plunge = true;
        } else {
            if (last_line_was_plunge) {
                last_line_was_plunge = false;
                continue;
            } else {
                plunges_removed += lines[i] + "\n";
            }
        }
        if (is_move_with_xy(lines[i])) {
            last_xy = get_xy(lines[i]);
        }
    }
    let add_back_plunges = "";
    let plunges_removed_lines = plunges_removed.split('\n');
    // let plunges_added_back = false
    for (let i = 0; i < plunges_removed_lines.length; i++) {
        if (plunges_removed_lines[i].substring(0, 8) === "; Path 0") {
            console.log("Found Path 0");
            add_back_plunges += plunges + "\n\n\n" + plunges_removed_lines[i] + "\n";
            
        } else {
            add_back_plunges += plunges_removed_lines[i] + "\n";
        }
    }
    return add_back_plunges
} 

function checkVariableType(variable) {
    if (typeof variable === 'string') {
      console.log('The variable is a string.');
    } else if (Array.isArray(variable)) {
      console.log('The variable is an array.');
    } else {
      console.log('The variable is neither a string nor an array.');
    }
}

function is_move_with_xy(gcode_line) {
    let components = gcode_line.split(" ");
    if (gcode_line.substring(0, 2) === "G0" || gcode_line.substring(0, 2) == "G1") {
        if (components[1].substring(0, 1) === "X") {
            if (components[2].substring(0, 1) === "Y") {
                console.log("Found a gcode move with x and y values");
                return true;
            } else {
                return false;
            }
        } else {
            return false;
        }
    } else {
        return false;
    }
}

function get_xy(gcode_move) {
    // let x = 0.0;
    // let y = 0.0;
    let components = gcode_move.split(" ");
    const x = parseFloat(components[1].substring(1, components[1].length));
    const y = parseFloat(components[2].substring(1, components[2].length));
    return [x, y];
}
  
