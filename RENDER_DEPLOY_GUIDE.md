# 🚀 Deploying to Render.com for a Permanent 24/7 Shareable Link

Follow these simple steps to deploy your ID Card Registration Web App on **[Render.com](https://render.com)** for a **100% Permanent, Free 24/7 Link**:

---

## Step 1: Upload your Code to GitHub (Free)
1. Go to [GitHub.com](https://github.com) and create a free account (if you don't already have one).
2. Create a **New Repository** named `id-card-generator`.
3. Push or upload all files from your folder `E:\Coding\ID Card Generation` to your GitHub repository.

---

## Step 2: Deploy on Render.com (100% Free & Permanent)
1. Go to **[dashboard.render.com](https://dashboard.render.com)** and sign up with GitHub.
2. Click **New +** > Select **Web Service**.
3. Connect your GitHub repository `id-card-generator`.
4. Set the following options:
   - **Name**: `school-id-portal` (or any custom name)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. Click **Create Web Service**!

---

## 🎉 Your Permanent 24/7 Shareable Link is Live!

Render will generate a permanent web URL like:
👉 **`https://school-id-portal.onrender.com`**

- **Share with Students**: Send `https://school-id-portal.onrender.com` to anyone! It will stay online 24/7 forever without needing your computer turned on.
- **Admin Access**: Open `https://school-id-portal.onrender.com/admin.html` (Password: `admin123`).
- **Download Data & Photos**: In Admin Dashboard, click:
  - **`📊 Export Excel (.xlsx)`** to download all student details spreadsheet.
  - **`🖼️ Download Photos (.zip)`** to download all student photos neatly organized by class folders in 1 click!
