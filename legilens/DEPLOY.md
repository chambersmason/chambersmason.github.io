# LegiLens Deployment Guide

Deploy the Congress Funding Network viewer to `masonchambers.com/legilens`

## What's in this folder

```
legilens-public/
├── index.html              (48KB - the viewer app)
├── data/
│   └── congress-funding.json   (5.4MB - funding data)
└── DEPLOY.md               (this file)
```

Total size: ~5.5MB

---

## Option A: Add to Your Existing GitHub Pages Site (Recommended)

Since `masonchambers.com` is already hosted via GitHub Pages, this is the easiest approach.

### Steps:

1. **Open your masonchambers.com GitHub repo**
   ```
   https://github.com/YOUR_USERNAME/YOUR_SITE_REPO
   ```

2. **Create a `legilens` folder in the repo root**
   - Click "Add file" > "Create new file"
   - Type `legilens/index.html` as the filename
   - This creates both the folder and file

3. **Copy the contents of `index.html`**
   - Open `legilens-public/index.html` in a text editor
   - Copy ALL contents
   - Paste into the GitHub file editor
   - Click "Commit changes"

4. **Upload the data file**
   - Navigate to your repo's `legilens` folder
   - Click "Add file" > "Upload files"
   - Drag the entire `data` folder (or create `legilens/data/` first, then upload `congress-funding.json`)
   - Commit

5. **Wait 1-2 minutes for GitHub Pages to deploy**

6. **Visit `https://masonchambers.com/legilens`**

---

## Option B: Use GitHub's Web Upload (Faster for large files)

1. **Clone your site repo locally** (if not already)
   ```bash
   git clone https://github.com/YOUR_USERNAME/YOUR_SITE_REPO.git
   cd YOUR_SITE_REPO
   ```

2. **Copy the legilens-public folder**
   ```bash
   # From this LegiLens project folder:
   cp -r legilens-public /path/to/YOUR_SITE_REPO/legilens

   # Remove the deploy guide (optional)
   rm /path/to/YOUR_SITE_REPO/legilens/DEPLOY.md
   ```

3. **Push to GitHub**
   ```bash
   cd /path/to/YOUR_SITE_REPO
   git add legilens/
   git commit -m "Add LegiLens funding viewer"
   git push
   ```

4. **Visit `https://masonchambers.com/legilens`** after 1-2 minutes

---

## Option C: Cloudflare Pages (Separate Project)

If you want LegiLens on a separate deployment:

1. **Create a new GitHub repo** (e.g., `legilens-viewer`)

2. **Push this folder's contents to it**
   ```bash
   cd legilens-public
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/legilens-viewer.git
   git push -u origin main
   ```

3. **Go to Cloudflare Dashboard > Pages**

4. **Click "Create a project" > "Connect to Git"**

5. **Select your `legilens-viewer` repo**

6. **Configure build settings:**
   - Build command: (leave empty)
   - Build output directory: `/`
   - Click "Save and Deploy"

7. **Set up custom domain (optional):**
   - Go to your project > "Custom domains"
   - Add `legilens.masonchambers.com` or configure a path rule

---

## Verify It Works

After deployment, test these features:
- [ ] Page loads at your URL
- [ ] Graph visualizes with nodes and links
- [ ] Sidebar tabs switch between views (PACs, Employers, Bipartisan, etc.)
- [ ] Search and filters work
- [ ] Clicking nodes shows detail panel
- [ ] AI chat works (if you add an API key)

---

## Troubleshooting

**Blank page / "Failed to load data"**
- Check that `data/congress-funding.json` is in the right location
- Check browser console (F12) for 404 errors

**CORS errors**
- GitHub Pages and Cloudflare Pages both handle CORS correctly for static files
- If testing locally, use a local server: `python3 -m http.server 8000`

**Large file upload fails on GitHub web UI**
- Use Option B (git command line) for the 5.4MB JSON file

---

## Local Testing

Before deploying, test locally:

```bash
cd legilens-public
python3 -m http.server 8000
# Open http://localhost:8000
```
