import csv
import json

# takes an existing JSON file that is the dataset for the book tracking app
# and a CSV file that consists of book titles, authors, and the ISBN
# number. This script reads in both files and transfers the ISBN numbers
# from the CSV files to the corresponding records in the JSON data and
# write the result to a file that can then be used in the book tracking
# app. written by Grok.

json_file = 'books-read.json'
csv_file = 'books_with_isbn.csv'
output_file = 'isbn_updated_books.json'


def normalize(s):
    return s.strip().lower().replace('"', '').replace(',', '')

# Load CSV
isbn_dict = {}
with open(csv_file, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        title = normalize(row['Title'])
        author = normalize(row['Author'])
        isbn = row['ISBN'].strip()
        if isbn:
            isbn_dict[(title, author)] = isbn

# Load JSON
with open(json_file, 'r', encoding='utf-8') as f:
    data = json.load(f)

# Update JSON
for book in data['BooksRead']:
    title = normalize(book.get('Title', ''))
    author = normalize(book.get('Author', ''))
    key = (title, author)
    if key in isbn_dict:
        book['ISBN'] = isbn_dict[key]

# Save updated JSON
with open(output_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=4)

print(f'Updated JSON saved to {output_file}')
