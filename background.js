// background.js — Flow Automation Service Worker (Production)

// ─── Download Handler ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "download") {
        const { url, filename, projectName, quality } = msg;

        if (quality === "No Download" || !url) {
            sendResponse({ ok: true, skipped: true });
            return true;
        }

        const safeProject = (projectName || "flow_project").replace(/[^a-z0-9_\- ]/gi, '_');
        const fullPath = `${safeProject}/${filename}`;

        chrome.downloads.download({
            url: url,
            filename: fullPath,
            conflictAction: 'uniquify'
        }, (id) => {
            if (chrome.runtime.lastError) {
                console.error("[FLOW BG] Download error:", chrome.runtime.lastError.message);
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ ok: true, id });
            }
        });
        return true;
    }

    if (msg.action === "getTab") {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            sendResponse({ url: tabs[0]?.url || "" });
        });
        return true;
    }
});

// ─── Install Defaults ───
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['settings'], (r) => {
        if (!r.settings) {
            chrome.storage.local.set({
                settings: {
                    defaultMode: 't2v', defaultAspect: '16:9', outputsPerPrompt: 1,
                    maxConcurrent: 1, delayMin: 20, delayMax: 30,
                    videoModel: 'veo_3_1_fast', imageModel: 'nano_banana_2',
                    downloadVideoQuality: '1080p', downloadImageQuality: '4k',
                    projectName: 'flow_project', maxRetries: 2, defaultVideoFrame: '8s',
                    maxImagesPerPrompt: 2, language: 'es'
                }
            });
        }
    });
});
