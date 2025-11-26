# The Stupid-Simple Book Tracker

> The solution is located at [book.ankile.com](https://book.ankile.com).

This responsive single-page app allows one to keep track of what one's reading, as well as give some indication as to how long books will take to complete.

## Prerequisites

- Node.js (tested with Node.js 22+)
- npm (comes with Node.js)
- Firebase CLI: `npm install -g firebase-tools`

## Installation & Setup

### 1. Clone the repository

```bash
git clone <repository-url>
cd book-tracker
```

### 2. Install dependencies

Due to compatibility issues with older dependencies on modern Node.js versions, you need to use specific flags:

```bash
# Install root dependencies (for the web app)
npm install --legacy-peer-deps --ignore-scripts

# Install Firebase Functions dependencies
cd functions
npm install --legacy-peer-deps
cd ..
```

**Note:** The `--ignore-scripts` flag is needed because `node-sass` (legacy dependency) doesn't build on newer Node.js/macOS ARM64. We use modern `sass` instead.

### 3. Firebase Configuration

If this is your first time setting up the project:

```bash
# Login to Firebase
firebase login

# Initialize Firebase (if not already done)
firebase init
```

The project is already configured to use the Firebase project `book-tracker-d8f24` (see `.firebaserc`).

## Local Development

### Running the Development Server

Start the development server with watch mode and live reload:

```bash
npm run dev
```

This will:
- Start Rollup in watch mode (rebuilds on file changes)
- Start a local server on **http://localhost:3000**
- Enable live reload for automatic browser refresh

**Note:** The server runs on port 3000 instead of 5000 to avoid conflicts with macOS AirPlay Receiver.

### Building for Production

```bash
npm run build
```

This creates an optimized production build in the `public/build/` directory.

### Testing Functions Locally

To test Firebase Functions locally using emulators:

```bash
cd functions
npm run serve
```

## Deployment

### Prerequisites for Deployment

1. Make sure you're logged into Firebase:
   ```bash
   firebase login
   ```

2. Verify you're deploying to the correct project:
   ```bash
   firebase use default
   # Should show: book-tracker-d8f24
   ```

### Deploy Everything

To deploy both hosting and functions:

```bash
# Build the web app first
npm run build

# Deploy everything
firebase deploy
```

### Deploy Hosting Only

To deploy just the web app (faster for frontend-only changes):

```bash
# Build the web app
npm run build

# Deploy hosting
firebase deploy --only hosting
```

### Deploy Functions Only

To deploy just the Firebase Functions (faster for backend-only changes):

```bash
# The predeploy hooks will automatically lint and build
firebase deploy --only functions
```

Or use the npm script:

```bash
cd functions
npm run deploy
```

### View Deployment Logs

```bash
# View function logs
firebase functions:log

# Or use the npm script
cd functions
npm run logs
```

## Project Structure

```
book-tracker/
├── src/                    # Svelte source files
├── public/                 # Static assets and compiled output
│   ├── build/             # Compiled JS and CSS (generated)
│   └── index.html         # Main HTML file
├── functions/             # Firebase Cloud Functions
│   └── src/              # Function source code
├── rollup.config.js      # Rollup bundler configuration
├── package.json          # Root dependencies
└── firebase.json         # Firebase configuration
```

## Troubleshooting

### Port 5000 Already in Use

macOS AirPlay Receiver uses port 5000 by default. This project is configured to use port 3000 instead. If you need to change the port, edit `rollup.config.js` and modify the `--port` flag in the `serve()` function.

### Node.js Version Issues

The Firebase Functions require Node.js 16 (see `functions/package.json`). If you're running a different version locally, consider using a Node version manager like `nvm`:

```bash
nvm install 16
nvm use 16
```

### Dependency Installation Fails

If you encounter errors during `npm install`:

1. Make sure you're using the `--legacy-peer-deps` flag
2. For the root directory, also use `--ignore-scripts`
3. Delete `node_modules` and try again:
   ```bash
   rm -rf node_modules package-lock.json
   npm install --legacy-peer-deps --ignore-scripts
   ```

### SASS Deprecation Warnings

The deprecation warnings about the legacy JS API are expected and harmless. They occur because `svelte-preprocess` uses the legacy SASS API. These can be safely ignored.

## Available Scripts

### Root Directory

- `npm run dev` - Start development server with watch mode
- `npm run build` - Build for production
- `npm run start` - Serve the built app (production mode)
- `npm run validate` - Run Svelte type checking

### Functions Directory

- `npm run build` - Compile TypeScript functions
- `npm run serve` - Start Firebase emulators for local testing
- `npm run deploy` - Deploy functions to Firebase
- `npm run logs` - View function logs
- `npm run lint` - Lint function code
