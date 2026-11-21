// What a person's photo may be, in a file of its own without Zod, so the web app can read it without bundling Zod.

/**
 * What a person's photo may be when it comes in, the same for the server, the web and the CLI: a PNG, JPEG or WebP
 * (known by its bytes, never by a name or a header; never an SVG, which can carry code), of at most `maxBytes` and
 * `maxPixels`. The server keeps the square in the middle, `side` pixels a side, as WebP, with nothing else the file
 * carried (where it was taken, the camera...). A square is kept whole: the web app sends the square the person chose,
 * and someone who wants another part of a photo through the CLI crops it square first.
 */
export const PHOTO_LIMITS = { maxBytes: 20 * 1024 * 1024, maxPixels: 50_000_000, side: 256 } as const;
