const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── API KEYS ──────────────────────────────────────────────────
// Two Spoonacular keys — if one runs out of points, the other takes over
// Each key gives ~150 points/day free = ~75 searches each
// Together you get ~150 searches/day total
const SP_KEYS = [
  process.env.SPOONACULAR_KEY   ,
  process.env.SPOONACULAR_KEY2 
];
let spKeyIndex = 0; // tracks which key we're currently using

// TheMealDB — free, no key needed, used as fallback when Spoonacular is exhausted
const MEAL_URL = 'https://www.themealdb.com/api/json/v1/1';
const YT_KEY   = process.env.YT_KEY ;
const SP_URL   = 'https://api.spoonacular.com';
const YT_URL   = 'https://www.googleapis.com/youtube/v3';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPER: fetch a URL and return parsed JSON ────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'RecipeLens/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

// ── HELPER: get current Spoonacular key ───────────────────────
function spKey() { return SP_KEYS[spKeyIndex]; }

// ── HELPER: check if Spoonacular response says quota exceeded ─
// Returns true if we should switch keys and retry
function isQuotaError(data) {
  return data && (
    data.status === 'failure' ||
    (data.code && data.code === 402) ||
    (typeof data.message === 'string' && data.message.toLowerCase().includes('quota'))
  );
}

// ── HELPER: Spoonacular search with automatic key rotation ────
// If key 1 is exhausted, silently switches to key 2 and retries
async function spSearch(query, number, extraParams = '') {
  for (let attempt = 0; attempt < SP_KEYS.length; attempt++) {
    const key = SP_KEYS[spKeyIndex];
    // STEP 1: cheap search — just gets IDs (1 point)
    const searchUrl = `${SP_URL}/recipes/complexSearch?query=${encodeURIComponent(query)}&number=${number}${extraParams}&apiKey=${key}`;
    const searchData = await fetchJSON(searchUrl);

    if (isQuotaError(searchData)) {
      console.log(`Spoonacular key ${spKeyIndex + 1} exhausted, switching to key ${((spKeyIndex + 1) % SP_KEYS.length) + 1}`);
      spKeyIndex = (spKeyIndex + 1) % SP_KEYS.length;
      if (spKeyIndex === 0) return null; // both keys exhausted
      continue; // retry with new key
    }

    if (!searchData.results || !searchData.results.length) return [];

    // STEP 2: bulk info — gets full details in ONE call (1 point total, not per recipe)
    const ids = searchData.results.map(r => r.id).join(',');
    const bulkUrl = `${SP_URL}/recipes/informationBulk?ids=${ids}&includeNutrition=false&apiKey=${SP_KEYS[spKeyIndex]}`;
    const bulkData = await fetchJSON(bulkUrl);

    if (isQuotaError(bulkData)) {
      spKeyIndex = (spKeyIndex + 1) % SP_KEYS.length;
      if (spKeyIndex === 0) return null;
      continue;
    }

    return Array.isArray(bulkData) ? bulkData.map(toSpShape).filter(Boolean) : [];
  }
  return null; // all keys failed
}

// ── HELPER: convert Spoonacular recipe → frontend shape ───────
function toSpShape(sp) {
  if (!sp || sp.status === 'failure') return null;
  const extras = {};
  (sp.extendedIngredients || []).slice(0, 20).forEach((ing, i) => {
    extras[`strIngredient${i+1}`] = ing.name || '';
    const meas = (ing.original || '').replace(new RegExp('\\b' + (ing.name || '') + '\\b', 'i'), '').trim();
    extras[`strMeasure${i+1}`] = meas || `${ing.amount || ''} ${ing.unit || ''}`.trim();
  });
  let instructions = '';
  if (sp.analyzedInstructions && sp.analyzedInstructions[0]) {
    instructions = sp.analyzedInstructions[0].steps.map(s => `${s.number}. ${s.step}`).join('\n\n');
  } else if (sp.instructions) {
    instructions = sp.instructions.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const tags = [];
  if (sp.vegetarian) tags.push('vegetarian');
  if (sp.vegan)      tags.push('vegan');
  return {
    idMeal:          'sp_' + sp.id, // prefix so we know it's Spoonacular
    strMeal:         sp.title || '',
    strMealThumb:    sp.image || '',
    strCategory:     (sp.dishTypes && sp.dishTypes[0]) ? sp.dishTypes[0].charAt(0).toUpperCase() + sp.dishTypes[0].slice(1) : 'Miscellaneous',
    strArea:         (sp.cuisines && sp.cuisines[0]) || '',
    strInstructions: instructions,
    strTags:         tags.join(','),
    strSource:       sp.sourceUrl || '',
    source:          'spoonacular',
    ...extras
  };
}

// ── HELPER: TheMealDB search (fallback) ───────────────────────
function dedupMeals(meals) {
  const seen = new Set();
  return meals.filter(m => { if (seen.has(m.idMeal)) return false; seen.add(m.idMeal); return true; });
}

async function fetchMealDetails(stubs, max = 12) {
  const toFetch = stubs.slice(0, max);
  const results = await Promise.all(
    toFetch.map(m => fetchJSON(`${MEAL_URL}/lookup.php?i=${m.idMeal}`).then(d => d.meals?.[0]).catch(() => null))
  );
  return results.filter(Boolean).map(m => ({ ...m, source: 'mealdb' }));
}

async function mealdbSearch(q) {
  const ql = q.toLowerCase();
  const words = ql.split(/\s+/).filter(w => w.length >= 3);
  let meals = [];
  // Direct name search
  const s1 = await fetchJSON(`${MEAL_URL}/search.php?s=${encodeURIComponent(q)}`).catch(() => ({}));
  if (s1.meals) meals.push(...s1.meals);
  // Individual word search (5+ chars only to avoid noise)
  for (const w of words.filter(w => w.length >= 5)) {
    if (w === ql) continue;
    const sx = await fetchJSON(`${MEAL_URL}/search.php?s=${encodeURIComponent(w)}`).catch(() => ({}));
    if (sx.meals) meals.push(...sx.meals.filter(m => words.some(w2 => m.strMeal.toLowerCase().includes(w2))));
  }
  // Ingredient search (single words only)
  if (words.length === 1 && ql.length <= 12) {
    const si = await fetchJSON(`${MEAL_URL}/filter.php?i=${encodeURIComponent(q)}`).catch(() => ({}));
    if (si.meals) {
      const existing = new Set(meals.map(m => m.idMeal));
      meals.push(...await fetchMealDetails(si.meals.filter(m => !existing.has(m.idMeal)), 6));
    }
  }
  return dedupMeals(meals).map(m => ({ ...m, source: 'mealdb' }));
}

// ════════════════════════════════════════════════════════════
//  GET /api/search?q=pasta
//  Tries Spoonacular first → falls back to TheMealDB
// ════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ meals: [], total: 0 });

  try {
    // Try Spoonacular first (more recipes, better search)
    const spMeals = await spSearch(q, 12);

    if (spMeals && spMeals.length > 0) {
      return res.json({ meals: spMeals, total: spMeals.length, source: 'spoonacular' });
    }

    // Spoonacular returned nothing or both keys exhausted — fall back to TheMealDB
    console.log('Falling back to TheMealDB for query:', q);
    const mealdbMeals = await mealdbSearch(q);
    res.json({ meals: mealdbMeals, total: mealdbMeals.length, source: 'mealdb' });

  } catch(err) {
    console.error('Search error:', err.message);
    // Even if everything crashes, try MealDB
    try {
      const fallback = await mealdbSearch(q);
      res.json({ meals: fallback, total: fallback.length, source: 'mealdb' });
    } catch(e2) {
      res.status(500).json({ error: err.message, meals: [] });
    }
  }
});

// ════════════════════════════════════════════════════════════
//  GET /api/meal/:id
//  ID is prefixed: "sp_12345" = Spoonacular, "12345" = MealDB
// ════════════════════════════════════════════════════════════
app.get('/api/meal/:id', async (req, res) => {
  const id = req.params.id;
  try {
    if (id.startsWith('sp_')) {
      // Spoonacular recipe
      const spId = id.replace('sp_', '');
      // Try current key, then other key
      for (let attempt = 0; attempt < SP_KEYS.length; attempt++) {
        const url = `${SP_URL}/recipes/${spId}/information?includeNutrition=false&apiKey=${SP_KEYS[spKeyIndex]}`;
        const sp  = await fetchJSON(url);
        if (isQuotaError(sp)) {
          spKeyIndex = (spKeyIndex + 1) % SP_KEYS.length;
          continue;
        }
        return res.json(toSpShape(sp));
      }
      // Both keys failed — can't load this recipe
      res.status(429).json({ error: 'Spoonacular quota exceeded on all keys. Try again tomorrow.' });
    } else {
      // TheMealDB recipe
      const data = await fetchJSON(`${MEAL_URL}/lookup.php?i=${id}`);
      res.json(data.meals?.[0] ? { ...data.meals[0], source: 'mealdb' } : null);
    }
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  GET /api/categories
// ════════════════════════════════════════════════════════════
app.get('/api/categories', async (req, res) => {
  const cats = [
    'Chicken','Beef','Lamb','Pork','Pasta','Dessert','Breakfast',
    'Seafood','Soup','Salad','Pizza','Burger','Curry',
    'Biryani','Steak','Tacos','Sushi','Noodles','Sandwich','Vegetarian'
  ].map(name => ({ strCategory: name }));
  res.json(cats);
});

// ════════════════════════════════════════════════════════════
//  GET /api/browse?category=Chicken  OR  ?area=Indian
// ════════════════════════════════════════════════════════════
app.get('/api/browse', async (req, res) => {
  const cat  = req.query.category || '';
  const area = req.query.area     || '';
  if (!cat && !area) return res.json({ meals: [] });

  try {
    let spMeals = null;
    if (area) {
      spMeals = await spSearch(area, 24, `&cuisine=${encodeURIComponent(area)}`);
    } else {
      const DIET_MAP = { Vegetarian: '&diet=vegetarian', Vegan: '&diet=vegan' };
      const dietParam = DIET_MAP[cat] || '';
      spMeals = await spSearch(cat, 24, dietParam);
    }

    if (spMeals && spMeals.length > 0) {
      return res.json({ meals: spMeals });
    }

    // Fallback to MealDB browse
    const AREA_MAP = { Italian:'Italian', Chinese:'Chinese', Japanese:'Japanese', Mexican:'Mexican', French:'French', Thai:'Thai' };
    const CAT_MAP  = { Chicken:'Chicken', Beef:'Beef', Lamb:'Lamb', Pasta:'Pasta', Dessert:'Dessert', Breakfast:'Breakfast', Vegetarian:'Vegetarian', Seafood:'Seafood' };

    let stubs = [];
    if (area && AREA_MAP[area]) {
      const r = await fetchJSON(`${MEAL_URL}/filter.php?a=${encodeURIComponent(AREA_MAP[area])}`).catch(() => ({}));
      if (r.meals) stubs = r.meals;
    } else if (cat && CAT_MAP[cat]) {
      const r = await fetchJSON(`${MEAL_URL}/filter.php?c=${encodeURIComponent(CAT_MAP[cat])}`).catch(() => ({}));
      if (r.meals) stubs = r.meals;
    }

    if (stubs.length) {
      const meals = await fetchMealDetails(stubs, 20);
      return res.json({ meals });
    }

    res.json({ meals: [] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  GET /api/youtube?q=pasta+carbonara&veg=true
// ════════════════════════════════════════════════════════════
app.get('/api/youtube', async (req, res) => {
  const q   = (req.query.q || '').trim();
  const veg = req.query.veg;
  if (!q) return res.json({ videos: [] });

  try {
    let searchQ = q + ' recipe';
    if (veg === 'true')  searchQ = 'vegetarian ' + q + ' recipe';
    if (veg === 'false') searchQ = q + ' non veg recipe';

    const search = await fetchJSON(
      `${YT_URL}/search?part=snippet&q=${encodeURIComponent(searchQ)}&type=video&maxResults=10&relevanceLanguage=en&key=${YT_KEY}`
    );
    if (!search.items?.length) return res.json({ videos: [] });

    const ids   = search.items.map(v => v.id.videoId).join(',');
    const stats = await fetchJSON(`${YT_URL}/videos?part=statistics,snippet&id=${ids}&key=${YT_KEY}`);

    let videos = (stats.items || []).map(v => ({
      videoId:   v.id,
      title:     v.snippet.title,
      channel:   v.snippet.channelTitle,
      thumb:     v.snippet.thumbnails?.medium?.url || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
      viewCount: parseInt(v.statistics?.viewCount || '0'),
      views:     fmtViews(parseInt(v.statistics?.viewCount || '0'))
    }));

    if (veg === 'true') {
      videos = videos.filter(v => !/\b(chicken|beef|lamb|mutton|pork|prawn|shrimp|fish|meat|non.?veg)\b/i.test(v.title));
    }

    videos.sort((a, b) => b.viewCount - a.viewCount);
    res.json({ videos: videos.slice(0, 8) });
  } catch(err) {
    console.error('YouTube error:', err.message);
    res.status(500).json({ error: err.message, videos: [] });
  }
});

function fmtViews(n) {
  if (!n) return '';
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return Math.round(n/1e3)+'K';
  return String(n);
}

app.listen(PORT, () => {
  console.log(`\n✅ Recipe Lens → http://localhost:${PORT}`);
  console.log(`   Spoonacular keys loaded: ${SP_KEYS.length}`);
  console.log(`   Estimated searches/day: ~${SP_KEYS.length * 75} (${SP_KEYS.length} keys × ~75 each)`);
  console.log(`   TheMealDB fallback: always available (no key needed)\n`);
});
