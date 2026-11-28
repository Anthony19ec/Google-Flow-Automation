// popup.js — Flow Automation Popup (Production)

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('goToFlowBtn');
    const info = document.getElementById('infoText');
    const dot = document.getElementById('statusDot');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = tabs[0]?.url || "";
        let page; try { page = new URL(url); } catch (_) { page = null; }
        const onFlow = !!page && (page.hostname === "flow.google.com" ||
            (page.hostname === "labs.google" && /^\/(fx\/tools\/flow|flow)(\/|$)/.test(page.pathname)));

        if (onFlow) {
            info.innerHTML = '<strong>Flow Automation</strong> is active on this tab.<br><br>Use the side panel on the page to manage your batch generation.';
            btn.style.display = "none";
            dot.style.background = "#2dd4bf";
        } else {
            info.innerHTML = '<strong>Flow Automation</strong> powers batch generation on Google Flow.<br><br>Open a Google Flow project page to get started.';
            btn.style.display = "block";
            dot.style.background = "#6b7280";
        }
    });

    btn.addEventListener('click', () => {
        chrome.tabs.create({ url: "https://flow.google.com/" });
    });
});
