# OnePick Parser Notes

## Architecture

`src/parsers/index.js` routes by platform id:

- `douyin` -> dedicated parser
- `xiaohongshu`, `kuaishou`, `bilibili`, `youtube`, `weibo`, `tiktok` -> dedicated parser
- recognized mainstream platforms such as Instagram, X/Twitter, Facebook, Vimeo, Reddit, Dailymotion, SoundCloud, Pinterest, Threads, Tumblr, Twitch -> generic `yt-dlp` parser

Shared utilities live in `src/parsers/shared.js`:

- URL extraction
- platform detection
- internal/private URL protection
- redirect resolution
- yt-dlp normalization
- unified response shape

## Add a dedicated parser

1. Create `src/parsers/<platform>.js`.
2. Export `parse<Platform>({ url, platform })`.
3. Return `buildParseResponse(...)`.
4. Register it in `src/parsers/index.js` `PARSERS`.

## Current status

- Douyin: dedicated preprocessor + browser/yt-dlp fallback. Handles short-link redirects and work id extraction.
- Xiaohongshu/Kuaishou: Cookie-gated dedicated parsers with browser fallback.
- Bilibili/YouTube/Weibo/TikTok: dedicated routing and platform-specific error handling around yt-dlp.
- Generic: yt-dlp fallback for recognized mainstream platforms and generic public URLs where supported.
