require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Groq
const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY 
});

app.use(cors());
app.use(express.static('public')); 
app.use(express.json());

// 🛠️ UTILS
const chunkArray = (arr, size) => {
    return Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
        arr.slice(i * size, i * size + size)
    );
};

// 🧮 PATTERN ENGINE
function findMetaPattern(tokens) {
    const stopWords = [
        "THE", "AND", "FOR", "SOL", "TOKEN", "COIN", "MEME", "PRO", "MAX", 
        "BULL", "PUMP", "MOON", "DEV", "CTO", "COMMUNITY", "OFFICIAL", 
        "REAL", "NEW", "FINANCE", "SWAP", "PROTOCOL", "BETA", "ALPHA", "BASE",
        "SOLANA", "COINS", "GROUP", "TEAM", "LIVE", "VIDEO", "GAME", "AI", "CHAT"
    ];

    const wordCounts = {};

    tokens.forEach(t => {
        const cleanName = t.name.toUpperCase().split('($')[0].replace(/[^A-Z ]/g, " ");
        const words = cleanName.split(/\s+/);

        words.forEach(w => {
            if (w.length > 2 && w.length < 15 && !stopWords.includes(w)) {
                wordCounts[w] = (wordCounts[w] || 0) + 1;
            }
        });
    });

    const sortedWords = Object.entries(wordCounts).sort((a, b) => b[1] - a[1]);

    if (sortedWords.length === 0) return { meta: "None", count: 0, filtered: tokens.slice(0, 20) };

    const topMetaWord = sortedWords[0][0]; 
    const count = sortedWords[0][1];

    let filteredTokens = tokens.filter(t => 
        t.name.toUpperCase().includes(topMetaWord) || 
        (t.description && t.description.toUpperCase().includes(topMetaWord))
    );

    return { meta: topMetaWord, count, filtered: filteredTokens };
}

// 🧠 AI ENGINE (Now using GROQ Cloud)
async function getAiAnalysis(metaWord, count, tokens) {
    if (count < 3) return "⚠️ Market is scattered. No strong narrative found.";

    const tokenText = tokens.slice(0, 8).map(t => 
        `- ${t.name} ($${t.symbol}): ${t.description ? t.description.slice(0,80) : "No Bio"}`
    ).join('\n');

    const prompt = `
    SCAN RESULT: Analyzed 200+ active Solana tokens.
    DOMINANT META: "${metaWord}" (Found ${count} projects matching this theme).
    
    Top Projects in this Meta:
    ${tokenText}

    TASK:
    1. Why is the "${metaWord}" meta trending right now?
    2. Which of these looks like the "Market Leader" vs "Clone"?
    3. Final Verdict: Is this trend early or saturated?
    
    Be brutally honest.
    `;

    try {
        const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.3-70b-versatile", 
});
        return completion.choices[0]?.message?.content || "No analysis generated.";
    } catch (e) {
        console.error("Groq Error:", e.message);
        return "⚠️ AI Error. Check API Key.";
    }
}

// ⚡ THE HUNTING ENDPOINT
app.get('/api/hunt', async (req, res) => {
    try {
        // 1. HARVEST (DexScreener)
        const [profilesRes, boostsRes, topRes] = await Promise.all([
            axios.get('https://api.dexscreener.com/token-profiles/latest/v1'),
            axios.get('https://api.dexscreener.com/token-boosts/latest/v1'),
            axios.get('https://api.dexscreener.com/token-boosts/top/v1')
        ]);

        const allRaw = [...profilesRes.data, ...boostsRes.data, ...topRes.data]
            .filter(t => t.chainId === 'solana');

        const uniqueAddresses = [...new Set(allRaw.map(t => t.tokenAddress))];
        
        // 2. CHUNK REQUESTS
        const chunks = chunkArray(uniqueAddresses, 30);
        let resolvedTokens = [];

        const batches = chunks.map(async (chunk) => {
            try {
                const ids = chunk.join(',');
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ids}`);
                return res.data?.pairs || [];
            } catch (e) { return []; }
        });

        const results = await Promise.all(batches);
        results.forEach(batch => { if (batch) resolvedTokens.push(...batch); });

        // Deduplicate
        const uniqueTokensMap = new Map();
        resolvedTokens.forEach(p => {
            const addr = p.baseToken.address;
            if (!uniqueTokensMap.has(addr) || (p.liquidity?.usd > uniqueTokensMap.get(addr).liquidity)) {
                const original = allRaw.find(r => r.tokenAddress === addr);
                uniqueTokensMap.set(addr, {
                    name: p.baseToken.name,
                    symbol: p.baseToken.symbol,
                    address: addr,
                    url: p.url,
                    icon: original ? original.icon : p.info?.imageUrl,
                    header: original ? original.header : p.info?.header,
                    description: original ? original.description : "No description."
                });
            }
        });

        const finalTokenList = Array.from(uniqueTokensMap.values());

        // 3. PATTERN RECOGNITION
        const { meta, count, filtered } = findMetaPattern(finalTokenList);

        // 4. AI ANALYSIS (Groq)
        const aiVerdict = await getAiAnalysis(meta, count, filtered);

        res.json({
            success: true,
            total_scanned: finalTokenList.length,
            meta_keyword: meta,
            meta_count: count,
            ai_analysis: aiVerdict,
            filtered_list: filtered
        });

    } catch (error) {
        console.error("Scan Error:", error.message);
        res.status(500).json({ success: false, error: "Massive Scan Failed." });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Cloud Hunter running on port ${PORT}`);
});