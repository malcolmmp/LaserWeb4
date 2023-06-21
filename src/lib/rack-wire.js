export function rackRoboPostProcess(gcode, wear_ratio, plunge_feed_rate, start_z, rapid_z, pass_depth, travel_speed_xy) {
    // console.log("Original Gcode: \n", gcode);
    let cuts = find_cuts(gcode);
    // console.log("Cuts: ");
    // log_array_of_strings(cuts.cut_blocks);
    // console.log("The rest: \n", cuts.the_rest);
    let subdiv_cuts = subdivide_cuts(cuts.cut_blocks, 0.4);
    // console.log("Subdivided Cuts: ");
    // log_array_of_strings(subdiv_cuts);
    // console.log("Z Added: \n");
    let cuts_with_z = add_z(subdiv_cuts, wear_ratio, pass_depth);
    // log_array_of_strings(z_added);
    let plunges = find_plunges_cuts_removed(cuts.the_rest);
    // console.log("Plunges: \n");
    // log_array_of_strings(plunges.plunges);
    // console.log("Plunges Removed: \n", plunges.the_rest);
    let plunges_with_feeds = add_plunge_feeds(plunges.plunges, plunge_feed_rate, travel_speed_xy, 10);
    let plunges_cuts_added = put_cuts_and_plunges(cuts_with_z, plunges_with_feeds, plunges.the_rest);
    // console.log("Plunges and Cuts Added: \n", plunges_cuts_added);
    return plunges_cuts_added;
}

function log_array_of_strings(the_array) {
    let string = "";
    for (let i = 0; i < the_array.length; i++) {
        for (let j = 0; j < the_array[i].length; j++) {
            string += the_array[i][j];
        }
        string += "\n";
    }
    console.log(string);
}

function find_cuts(gcode) {
    let cut_blocks = [];
    let gcode_lines = gcode.split('\n');
    let in_cut = false;
    let cut_block = "";
    let the_rest = "";
    let cut_block_counter = 0;
    for (let i = 0; i < gcode_lines.length; i++) {
        if (gcode_lines[i].substring(0, 5) === "; cut") {
            if (in_cut) {
                cut_blocks.push(cut_block);
                the_rest += "; add cut " + cut_block_counter + "\n";
                cut_block = "";
                cut_block += gcode_lines[i] + "\n";
                cut_block_counter++;
            } else {
                in_cut = true;
                cut_block += gcode_lines[i] + "\n";
            }
        } else if (gcode_lines[i].substring(0, 1) === ";") {
            if (in_cut) {
                cut_blocks.push(cut_block);
                the_rest += "; add cut " + cut_block_counter + "\n";
                cut_block = "";
                in_cut = false;
                cut_block_counter++;
            }
            the_rest += gcode_lines[i] + "\n";
        } else {
            if (in_cut) {
                cut_block += gcode_lines[i] + "\n";
            } else {
                the_rest += gcode_lines[i] + "\n";
            }
        }
    }
    return {cut_blocks: cut_blocks, the_rest: the_rest};
}

function find_plunges_cuts_removed(gcode) {
    let gcode_lines = gcode.split('\n');

    let retract_counter = 0;
    let plunges = [];
    let the_rest = "";
    let lines_to_retract_end = 0;
    for (let i = 0; i < gcode_lines.length; i++) {
        if (gcode_lines[i].substring(0, 9) === "; Retract") {
            let plunge = "";
            the_rest += "; add plunge " + retract_counter + "\n";
            plunge += gcode_lines[i] + "\n";
            plunge += gcode_lines[i + 1] + "\n";
            if (gcode_lines[i + 2] !== undefined) {
                plunge += gcode_lines[i + 2] + "\n";
            }
            if (gcode_lines[i + 3] !== undefined) {
                plunge += gcode_lines[i + 3] + "\n";
            }
            if (gcode_lines[i + 4] !== undefined) {
                plunge += gcode_lines[i + 4] + "\n";
            }
            if (gcode_lines[i + 5] !== undefined) {
                plunge += gcode_lines[i + 5] + "\n";
            }
            if (gcode_lines[i + 6] !== undefined) {
                plunge += gcode_lines[i + 6] + "\n";
            }
            if (gcode_lines[i + 7] !== undefined) {
                plunge += gcode_lines[i + 7] + "\n";
            }
            if (gcode_lines[i + 8] !== undefined) {
                plunge += gcode_lines[i + 8] + "\n";
            }
            plunges.push(plunge);
            retract_counter++;
            lines_to_retract_end = 8;
        } else {
            if (lines_to_retract_end === 0) {
                the_rest += gcode_lines[i] + "\n";
            } else {
                lines_to_retract_end--;
            }
        }
    }
    return {plunges: plunges, the_rest: the_rest};
}

function subdivide_cuts(cut_blocks, threshold) {
    let subdivided = [];
    for (let i = 0; i < cut_blocks.length; i++) {
        const gcode_lines = cut_blocks[i].split("\n");

        let new_gcode = "";
        for (let j = 0; j < gcode_lines.length; j++) {
            let line = parse_move(gcode_lines[j]);
            let next_xy = get_next_xy(cut_blocks[i], j);
            // For the last line, the next_xy will be null
            if (next_xy[0] === null || next_xy[1] === null) {
                new_gcode += gcode_lines[j] + "\n";
                break;
            }
            if (line.g === null) {
                // If the line is not a move, just add it to the new gcode
                new_gcode += gcode_lines[j] + "\n";
            } else {
                if (line.x !== null) {
                    if (line.y !== null) {
                        // If there is an x and y value in current line and there was an x and y value in a previous line
                        let diff = [line.x - next_xy[0], line.y - next_xy[1]];
                        let distance = Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
                        if (distance > threshold) {
                            let divided_points = get_points_on_2D_line([line.x, line.y], next_xy, threshold);
                            // log_array_of_arrays(divided_points, "divided_points");
                            for (let k = 0; k < divided_points.length; k++) {
                                let new_line = line;
                                new_line.x = divided_points[k][0];
                                new_line.y = divided_points[k][1];
                                new_gcode += move_as_str(new_line);
                            }
                        } else {
                            // If the distance between the two points is less than the threshold, just use the current point
                            new_gcode += move_as_str(line);
                        }
                    } else {
                        let diff = line.x - next_xy[0];
                        let distance = Math.abs(diff);
                        if (distance > threshold) {
                            let divided_points = get_points_on_1D_line(next_xy[0], line.x, threshold);
                            for (let k = 0; k < divided_points.length - 1; k++) {
                                let new_line = line;
                                new_line.x = divided_points[k];
                                new_gcode += move_as_str(new_line);
                            }
                        } else {
                            // If the distance between the two points is less than the threshold, just use the current point
                            new_gcode += move_as_str(line);
                        }
                    }
                } else {
                    if (line.y !== null) {
                        let diff = line.y - next_xy[1];
                        let distance = Math.abs(diff);
                        if (distance > threshold) {
                            let divided_points = get_points_on_1D_line(next_xy[1], line.y, threshold);
                            for (let k = 0; k < divided_points.length - 1; k++) {
                                let new_line = line;
                                new_line.y = divided_points[k];
                                new_gcode += move_as_str(new_line);
                            }
                        } else {
                            // If the distance between the two points is less than the threshold, just use the current point
                            new_gcode += move_as_str(line);
                        }
                    } else {
                        // This is for the case when we detect a move command but there is no x or y value
                        new_gcode += move_as_str(line);
                    }
                }
            }
        }
        subdivided.push(new_gcode);
    }
    return subdivided;
}

function add_z(cuts, wear_ratio, pass_depth) {
    let last_xy = [null, null];
    // let lines = gcode.split('\n');
    let current_z = pass_depth;
    let files_current_z = pass_depth;

    let new_cuts = [];
    for (let i = 0; i < cuts.length; i++) {
        let lines = cuts[i].split('\n');
        let new_cut = "";
        for (let j = 0; j < lines.length; j++) {
            let corrected = correct_line(lines[j], wear_ratio, last_xy, current_z, files_current_z);
            current_z += corrected.z_update;
            files_current_z += corrected.files_z_update;
            new_cut += corrected.gcode;
        }
        new_cuts.push({ gcode: new_cut, last_z: current_z });
    }
    // for (let i = 0; i < new_cuts.length; i++) {
    //     console.log(new_cuts[i].gcode);
    //     console.log("last_z: " + new_cuts[i].last_z);
    // }
    return new_cuts;
}

// files_current_z is telling us where the file thinks the z is
function correct_line(gcode_line, wear_ratio, last_xy, current_z, files_current_z) {
    let line = parse_move(gcode_line);
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
}

function put_cuts_and_plunges(cuts, plunges, gcode) {
    let lines = gcode.split('\n');

    let first_plunge_placed = false;
    let new_gcode = "";
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].substring(0, 12) === "; add plunge") {
            let count = parseInt(lines[i].substring(13, lines[i].length));
            if (first_plunge_placed) {
                if (cuts[count - 1].last_z === undefined) {
                    new_gcode += plunges[count];
                } else {
                    let plunge_with_z = update_plunge_z(plunges[count], cuts[count - 1].last_z);
                    new_gcode += plunge_with_z;
                }
            } else {
                new_gcode += plunges[count];
                first_plunge_placed = true;
            }
        } else if (lines[i].substring(0, 9) === "; add cut") {
            let count = parseInt(lines[i].substring(10, lines[i].length));
            new_gcode += cuts[count].gcode;
        } else {
            new_gcode += lines[i] + "\n";
        }
    }
    let with_plunges_at_begining = put_plunges_at_begining(new_gcode, plunges);
    return with_plunges_at_begining;
}

function add_plunge_feeds(plunges, plunge_speed, travel_speed, retract_speed) {
    // let travel_speed = 1000;
    // let plunge_speed = 100;
    // let retract_speed = 1000;
    let new_plunges = [];
    for (let i = 0; i < plunges.length; i++) {
        let new_plunge = "";
        let lines = plunges[i].split('\n');
        new_plunge += lines[0] + "\n";
        let retract = parse_move(lines[1])
        retract.f = retract_speed;
        retract.g = 1;
        new_plunge += move_as_str(retract);
        if (lines.length > 9) {
            new_plunge += lines[2] + "\n";
            new_plunge += lines[3] + "\n";
            new_plunge += lines[4] + "\n";
            let travel = parse_move(lines[5]);
            travel.f = travel_speed;
            travel.g = 1;
            new_plunge += move_as_str(travel);
            let plunge_to_zero = parse_move(lines[6]);
            plunge_to_zero.f = retract_speed;
            plunge_to_zero.g = 1;
            new_plunge += move_as_str(plunge_to_zero);
            new_plunge += lines[7] + "\n";
            let plunge = parse_move(lines[8]);
            plunge.f = plunge_speed;
            plunge.g = 1;
            new_plunge += move_as_str(plunge);
        }
        new_plunges.push(new_plunge);
    }
    return new_plunges;
}

function put_plunges_at_begining(gcode, plunges) {
    let lines = gcode.split('\n');
    let new_gcode = "";
    let found_where_to_put_plunges = false;
    let plunges_at_line = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].substring(0, 13) === "; Wear Ratio:" && !found_where_to_put_plunges) {
            new_gcode += lines[i] + "\n";
            plunges_at_line = i + 1;
            found_where_to_put_plunges = true;
        } else if (found_where_to_put_plunges && i === plunges_at_line) {
            new_gcode += lines[i] + "\n";
            for (let j = 0; j < plunges.length - 1; j++) {
                new_gcode += plunges[j];
            }
        } else {
            new_gcode += lines[i] + "\n";
        }
    }
    return new_gcode;
}

function update_plunge_z(plunge_gcode, new_z) {
    let lines = plunge_gcode.split('\n');
    let new_lines = "";
    if (lines[0] !== undefined) {
        new_lines += lines[0] + "\n";
    }
    if (lines[1] !== undefined) {
        new_lines += lines[1] + "\n";
    }
    if (lines[2] !== undefined) {
        new_lines += lines[2] + "\n";
    }
    if (lines[3] !== undefined) {
        new_lines += lines[3] + "\n";
    }
    if (lines[4] !== undefined) {
        new_lines += lines[4] + "\n";
    }
    if (lines[5] !== undefined) {
        new_lines += lines[5] + "\n";
    }
    if (lines[6] !== undefined) {
        new_lines += lines[6] + "\n";
    }
    if (lines[7] !== undefined) {
        new_lines += lines[7] + "\n";
    }
    // new_lines += lines[1] + "\n";
    // new_lines += lines[2] + "\n";
    // new_lines += lines[3] + "\n";
    // new_lines += lines[4] + "\n";
    // new_lines += lines[5] + "\n";
    // new_lines += lines[6] + "\n";
    // new_lines += lines[7] + "\n";
    if (lines[8] !== undefined) {
        let line = parse_move(lines[8]);
        line.z = new_z;
        new_lines += move_as_str(line) + "\n";
    }
    // let new_lines = [];
    // for (let i = 0; i < lines.length; i++) {
    //     let line = parse_move(lines[i]);
    //     if (line.g !== null) {
    //         if (line.z !== null) {
    //             line.z += current_z;
    //         }
    //     }
    //     new_lines.push(move_as_str(line));
    // }
    return new_lines;
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