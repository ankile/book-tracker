# The Stupid-Simple Book Tracker

> The solution is located at [book.ankile.com](https://book.ankile.com).

This responsive single-page app allows one to keep track of what one's reading, as well as give some indication as to how long books will take to complete.

## Screenshots

### Currently Reading
![Currently Reading Page](static/screenshots/currently_reading.png)

### Profile & Reading Activity
![Profile Page with Statistics and Reading Heatmap](static/screenshots/my_page.png)

## Features

### Core Functionality
- **Book Management**: Add, edit, and delete books from your library
- **Reading Progress**: Track current page and mark books as finished
- **Reading Sessions**: Log reading sessions with time spent and pages read
- **Session Management**: View, edit, and delete individual reading sessions

### Statistics & Analytics
- **Profile Dashboard**: Comprehensive reading statistics including:
  - Total books read and currently reading
  - Total time spent reading and pages read
  - Books per year average
  - Average time per finished book
  - Year-by-year breakdown with longest books

- **Reading Heatmap**: GitHub-style activity visualization showing:
  - Daily reading activity (pages read per day)
  - Customizable 3 AM day boundary (late-night sessions count as previous day)
  - Year selector (view specific years or last 12 months)
  - Current reading streak and longest streak tracking
  - Detailed tooltips with session information

### Organization & Filtering
- **Finished Books Page**: Browse completed books with:
  - Sort options: recently finished, title (A-Z), length, or time spent
  - Filter by year
  - Summary statistics for filtered view

- **Currently Reading**: View all books in progress

## Version 2.0 - Major Upgrade 🎉

Version 2.0 brings a complete modernization of the tech stack:

- **Svelte 5** with runes syntax (`$state`, `$derived`, `$effect`, `$props`)
- **SvelteKit 2** with file-based routing
- **Vite 7** build system (replacing Rollup)
- **Firebase 12** with modular SDK
- **TypeScript 5**
- **Bootstrap 5** for styling

## Prerequisites

- Node.js 22.12+ (pinned to Node.js 22.23.1 in `.nvmrc`)
- npm (comes with Node.js)
- Firebase CLI when deploying (the commands below use a pinned temporary copy)

## Installation & Setup

### 1. Clone the repository

```bash
git clone <repository-url>
cd book-tracker
```

### 2. Install dependencies

```bash
# Install root dependencies (for the web app)
npm install

# Install Firebase Functions dependencies
npm --prefix functions install
```

### 3. Firebase Configuration

If this is your first time setting up the project:

```bash
# Login to Firebase
npm exec --yes --package firebase-tools@15.24.0 -- firebase login

# Initialize Firebase (if not already done)
npm exec --yes --package firebase-tools@15.24.0 -- firebase init
```

The project is already configured to use the Firebase project `book-tracker-d8f24` (see `.firebaserc`).

## Local Development

### Running the Development Server

Start the development server with HMR (Hot Module Replacement):

```bash
npm run dev
```

This will:
- Start Vite development server with HMR
- Start a local server on **http://localhost:5173**
- Enable automatic browser refresh on file changes

### Building for Production

```bash
npm run build
```

This creates an optimized production build in the `public/` directory using SvelteKit's static adapter.

### Preview Production Build Locally

```bash
npm run preview
```

This serves the built app locally to test the production build before deploying.

### Testing Functions Locally

To test Firebase Functions locally using emulators:

```bash
npm --prefix functions run serve
```

### Run the complete validation suite

```bash
npm run validate
```

This runs Svelte diagnostics, PWA tests, Functions linting and compilation,
the production web build, a bundle-size budget, and production-dependency
security audits for both workspaces.

## Deployment

### Prerequisites for Deployment

1. Make sure you're logged into Firebase:
   ```bash
   npm exec --yes --package firebase-tools@15.24.0 -- firebase login
   ```

2. Verify you're deploying to the correct project:
   ```bash
   npm exec --yes --package firebase-tools@15.24.0 -- firebase use default
   # Should show: book-tracker-d8f24
   ```

3. Before the first Functions deployment from this version, migrate the
   existing Runtime Config to Secret Manager:

   ```bash
   npm exec --yes --package firebase-tools@15.24.0 -- \
     firebase functions:config:export \
     --project book-tracker-d8f24 \
     --secret FUNCTIONS_CONFIG_EXPORT \
     --force
   ```

   This preserves the existing `booksapi` URL and API key without printing or
   copying the secret into the repository.

### Deploy Everything

To deploy both hosting and functions:

```bash
# Build the web app first
npm run build

# Deploy everything
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy
```

### Deploy Hosting Only

To deploy just the web app (faster for frontend-only changes):

```bash
# Build the web app
npm run build

# Deploy hosting
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only hosting
```

### Deploy to Preview Channel

Test your changes on a temporary URL before deploying to production:

```bash
# Build the app
npm run build

# Deploy to a preview channel (expires in 30 days)
npm exec --yes --package firebase-tools@15.24.0 -- \
  firebase hosting:channel:deploy preview --expires 30d
```

### Deploy Functions Only

To deploy just the Firebase Functions (faster for backend-only changes):

```bash
# The predeploy hooks will automatically lint and build
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only functions
```

Or use the npm script:

```bash
npm --prefix functions run deploy
```

### View Deployment Logs

```bash
# View function logs
npm exec --yes --package firebase-tools@15.24.0 -- firebase functions:log

# Or use the npm script
npm --prefix functions run logs
```

## Project Structure

```
book-tracker/
├── src/                    # Svelte source files
│   ├── app.html           # SvelteKit HTML template
│   ├── routes/            # SvelteKit file-based routes
│   │   ├── +layout.svelte # Root layout (auth guard)
│   │   ├── +page.svelte   # Home page (reading books)
│   │   ├── finished/      # Finished books page
│   │   └── me/            # User profile page
│   └── lib/               # Shared components and utilities
│       ├── components/    # Svelte 5 components
│       ├── firebase/      # Firebase configuration and utilities
│       ├── interfaces/    # TypeScript interfaces
│       └── utils/         # Utility functions
├── static/                # Static assets (favicon, manifest, etc.)
├── public/                # Build output (generated by SvelteKit)
├── functions/             # Firebase Cloud Functions
│   └── src/              # Function source code
├── svelte.config.js      # SvelteKit configuration
├── vite.config.js        # Vite bundler configuration
├── package.json          # Root dependencies
└── firebase.json         # Firebase configuration
```

## Technology Stack

### Frontend
- **Svelte 5.56.6** - Reactive UI framework with runes
- **SvelteKit 2.70.1** - Application framework with routing
- **Vite 7.3.6** - Fast build tool with HMR
- **TypeScript 5.9.3** - Type-safe JavaScript
- **Bootstrap 5.3.8** - CSS framework

### Backend
- **Firebase 12.16.0** - Authentication and Firestore database
- **Firebase Functions 7.3.0** on Node.js 22 - Serverless cloud functions

## Development Guide

### Svelte 5 Runes

This project uses Svelte 5's new runes syntax:

```javascript
// Reactive state
let count = $state(0);

// Derived state
let doubled = $derived(count * 2);

// Side effects
$effect(() => {
  console.log(`Count is ${count}`);
});

// Component props
let { title, onclick } = $props();
```

### SvelteKit Routing

Routes are defined by the file structure in `src/routes/`:

- `/` - Home page (reading books)
- `/finished` - Finished books page
- `/me` - User profile page

### Firebase Integration

The app uses Firebase v12 modular SDK:

```javascript
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, query, where } from 'firebase/firestore';
```

## Troubleshooting

### Node.js Version Issues

This project requires Node.js 22.12+. If you're running a different version, consider using a Node version manager like `nvm`:

```bash
nvm install 22
nvm use 22
```

### Dependency Installation Fails

Confirm `node --version` satisfies `package.json`; with `nvm`, run:

```bash
nvm install
nvm use
```

## Available Scripts

### Root Directory

- `npm run dev` - Start Vite development server (http://localhost:5173)
- `npm run build` - Build for production using SvelteKit
- `npm run preview` - Preview production build locally
- `npm test` - Run web checks, PWA tests, and Functions tests
- `npm run validate` - Run the complete build, test, and audit suite
- `npm run check` - Run Svelte type checking
- `npm run check:watch` - Run type checking in watch mode

### Functions Directory

- `npm run build` - Compile TypeScript functions
- `npm run serve` - Start Firebase emulators for local testing
- `npm run deploy` - Deploy functions to Firebase
- `npm run logs` - View function logs
- `npm run lint` - Lint function code

## Migration Notes (v1.0 → v2.0)

If you're upgrading from version 1.0:

1. **Build system changed**: Rollup → Vite (much faster builds)
2. **Routing changed**: svelte-routing → SvelteKit file-based routing
3. **Firebase SDK changed**: v8 compat API → v12 modular API
4. **Component syntax changed**: Svelte 3 → Svelte 5 runes
5. **Event handlers changed**: `on:click` → `onclick`
6. **Bootstrap upgraded**: v4 → v5
7. **Port changed**: 3000 → 5173 (Vite default)

## License

MIT
