# slugify

`slugify(text)` in `src/slugify.js` turns a title into a URL slug:

1. Lowercase.
2. Accented letters become their base letter ("Café" → "cafe").
3. Any run of characters other than a–z and 0–9 becomes a single "-".
4. No leading or trailing "-".
5. At most 40 characters. A longer slug is cut back to whole words: keep the longest prefix of at most 40 characters that ends right before a "-". If the first 41 characters contain no "-", cut at 40.
6. If the result is empty, return "untitled".
