

# HealthHub

HealthHub is a React + Vite dashboard demonstrating Firebase Authentication, Firestore, and Realtime Database integration.

## Features

- Firebase Authentication (email/password + Google)
- Firestore-based app data
- Realtime Database examples

## Prerequisites

- Node.js (14+)
- npm

## Setup

1. Install dependencies:
   `npm install`
2. Configure Firebase:
   - Open [firebase-applet-config.json](firebase-applet-config.json) and replace the keys with your Firebase project credentials (projectId, apiKey, authDomain, appId, storageBucket, firestoreDatabaseId, messagingSenderId).
   - If you use a different Realtime Database URL, update it in `src/firebase.ts`.
3. Run the app locally:
   `npm run dev`

## Build

Build the production bundle:

```
npm run build
npm run preview
```

## Contributing

Feel free to open issues or PRs.

## License

MIT
