# RecipeLens 🍳

Full-stack recipe finder with live YouTube videos, ranked by view count.

## Setup (takes 2 minutes)

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Install dependencies
Open terminal in this folder and run:
```
npm install express
```

### 3. Start the server
```
node server.js
```

### 4. Open in browser
Go to: http://localhost:3000

---

## What's inside

- **server.js** — Express backend, handles all API calls securely
- **public/index.html** — Full frontend app
- YouTube API key is kept server-side (never exposed to browser)
- MealDB is free, no key needed

## APIs used

| API | Purpose | Cost |
|-----|---------|------|
| YouTube Data API v3 | Live videos, real view counts | Free (10,000 units/day) |
| TheMealDB | Recipe data, ingredients, images | Free forever |

## Search strategies

The app uses 5 search strategies combined to give maximum results:
1. Direct name search
2. First-letter browsing with keyword filter  
3. Category-based search (chicken → Chicken category)
4. Ingredient-based search
5. Cuisine/area search (Indian → all Indian recipes)

## Features
- Full-screen recipe modal with ingredients + instructions
- YouTube videos sorted by real view count
- Veg / Non-veg filter
- Login & signup (stored locally)
- Save to favourites
- Browse by category
