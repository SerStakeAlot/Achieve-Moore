# Slideshow Photos

Drop your image files (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`) into this folder.

Then open [`photos.json`](photos.json) and list each filename in the `photos` array, for example:

```json
{
  "photos": [
    { "src": "event1.jpg", "caption": "Community Service Day" },
    { "src": "event2.jpg", "caption": "Mentorship Program" },
    { "src": "event3.png", "caption": "" }
  ]
}
```

The slideshow on the homepage will automatically pick them up — no code changes needed.
