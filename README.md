# OfferGuard

Hosted web app + Chrome extension that verifies internship/job offers, using TinyFish for live web checks.
One backend serves both: after deploying, your live URL IS the web app, and the extension just points to it.

## Step 1: Get your TinyFish API key (mandatory part)
1. Go to https://agent.tinyfish.ai and sign up or log in.
2. Open the API keys page (https://agent.tinyfish.ai/api-keys), create a key, and copy it.
3. Keep it secret. Never put it in the extension, in config.js, or on GitHub.

## Step 2 (optional): Try it on your computer first
```
cd backend
cp .env.example .env      # open .env and paste your key after TINYFISH_API_KEY=
node server.js            # needs Node 18+
```
Open http://localhost:8787, click "Test TinyFish". You should see "Search OK" and "Fetch OK".

## Step 3: Put the code on GitHub
Create a new GitHub repository and upload everything in this folder (render.yaml, backend/, extension/, README.md, .gitignore). Do NOT upload a .env file.

## Step 4: Deploy on Render (free)
1. Sign up at https://render.com and connect your GitHub account.
2. New + > Blueprint > pick your repo. (Or New + > Web Service with build command `echo ok` and start command `node backend/server.js`.)
3. When asked for TINYFISH_API_KEY, paste your key. (Or add it later under the service's Environment tab.)
4. Deploy. You get a URL like https://offerguard.onrender.com. Open it and click "Test TinyFish".

Free Render services sleep after about 15 minutes of no traffic, so open the URL a minute before your demo.
The reports file is not permanent on the free plan; the demo seed reports come back after a restart.

## Step 5: Connect the extension to your live URL
- Easiest: open the extension, expand Settings, paste your URL, click Save.
- Or edit extension/config.js and set OFFERGUARD_API to your URL before loading it.
- Load it: chrome://extensions > Developer mode > Load unpacked > choose the `extension` folder.

## Demo text
Congratulations! You are selected for Software Developer Intern at TechVista Solutions Pvt Ltd. Pay a refundable registration fee of ₹999 to hr.techvista@okaxis within 24 hours to confirm. Contact us on WhatsApp +91 9876543210. Send your Aadhaar and PAN. Email: techvista.careers@gmail.com. Form: https://bit.ly/techvista-form

## Where TinyFish is used
- Search: scam-related results for the company; finds its likely official site and compares it with the sender's domain
- Fetch: reads the official site; previews links from the offer so the student never opens them
- Agent (optional, experimental): set USE_TINYFISH_AGENT=1 for a careers-page check
- Every report shows a "TinyFish activity" panel listing each call, so judges can see real usage

## Safety
The public backend limits each visitor to 20 checks per 10 minutes to protect your TinyFish usage. Results are risk indicators, not proof.
