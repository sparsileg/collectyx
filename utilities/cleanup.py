# remove a JSON field (BookCoverURL) from a JSON file, ensuring that commas
# are handled correctly.

def process_file(input_path, output_path):
    with open(input_path, 'r', encoding='utf-8', errors='replace') as infile:
        lines = infile.readlines()

    result_lines = []
    for i, line in enumerate(lines):
        if 'BookCoverUrl' in line:
            # If line does not end with a comma, remove trailing comma from previous line
            if not line.rstrip().endswith(',') and result_lines:
                # Remove trailing comma from previous line if any
                result_lines[-1] = result_lines[-1].rstrip('\n').rstrip(',') + '\n'
            # Skip the line containing BookCoverUrl
            continue
        else:
            result_lines.append(line)

    with open(output_path, 'w', encoding='utf-8', errors='replace') as outfile:
        outfile.writelines(result_lines)


# Usage example
input_file = 'books-read.json'
output_file = 'fred.json'
process_file(input_file, output_file)
