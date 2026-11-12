# HIM DISHA

Premium learning frontend built with React and Vite.

## Run locally
```bash
npm install
npm run dev
```

## Production build
```bash
npm run build
npm run preview
```

## Data source
The batch catalogue is requested from:
`https://hrrydoc.vercel.app/api/disha/batches`

The UI accepts common JSON list envelopes (`batches`, `data`, `results`, `items`, `courses`, or `payload`) and recognizes common banner, chapter, PDF and video URL fields. The API must return browser-accessible JSON and media URLs; PDF embedding/download and video playback are subject to the source server's CORS, hosting and browser policies.

Telegram community: https://t.me/HIMAPPS
