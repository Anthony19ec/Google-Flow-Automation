// content.js — Flow Automation Engine (Production)
// Fully connects to Google Flow AI DOM for real automation

(function () {
    'use strict';

    // ══════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════
    let settings = {};
    let queue = [];       // { id, mode, text, files:[], status:'pending'|'running'|'done'|'failed'|'skipped', retries:0, error:'' }
    let isRunning = false;
    let activeRuns = 0;
    let shadowRef = null;

    const wait = (s) => new Promise(r => setTimeout(r, s * 1000));
    const uid = () => Math.random().toString(36).slice(2, 9);
    const rDelay = () => Flow.getRandomDelay(settings.delayMin || 20, settings.delayMax || 30);
    let uploadedFiles = []; // Persistent file storage across interactions
    let draggedIdx = null;  // Track dragged item for reordering
    const QUEUE_KEY = 'flow_automation_queue_v1_2';
    let queueReady = false;
    let queueWrite = Promise.resolve();
    let nextSequence = 1;
    function saveQueue() {
        if (!queueReady) return;
        const items = queue.slice(-500).map(q => ({
            id:q.id, sequence:q.sequence, mode:q.mode, text:q.text, status:q.status,
            retries:q.retries, error:q.error, sentToFlow:!!q.sentToFlow,
            hasFiles:!!((q.files && q.files.length) || q.hasFiles)
        }));
        queueWrite = queueWrite.catch(() => {}).then(() => Flow.Storage.set(QUEUE_KEY,items));
    }
    async function loadQueue() {
        const saved = await Flow.Storage.get(QUEUE_KEY,[]);
        if (Array.isArray(saved)) queue = saved.slice(-500).filter(q => q && typeof q.text === 'string' && q.text.trim()).map((q,i) => {
            const mode = ['t2i','i2i','t2v','i2v','c2v'].includes(q.mode) ? q.mode : 't2i';
            const hasFiles = Boolean(q.hasFiles || ['i2i','i2v','c2v'].includes(mode));
            const interrupted = !!q.sentToFlow || ['running','retrying','interrupted'].includes(q.status);
            const status = hasFiles || interrupted ? 'interrupted' :
                ['pending','done','failed','skipped'].includes(q.status) ? q.status : 'interrupted';
            return {id:String(q.id||uid()),sequence:Number(q.sequence)||i+1,mode,
                text:q.text.slice(0,20000),files:[],hasFiles,status,retries:Number(q.retries)||0,
                error:hasFiles ? 'Vuelve a cargar las imágenes de referencia y crea otra tarea.' :
                    interrupted ? 'Revisa en Flow antes de repetir esta tarea.' : String(q.error||'')};
        });
        nextSequence = Math.max(0,...queue.map(q=>Number(q.sequence)||0))+1;
        queueReady = true;
    }

    // ══════════════════════════════════════════════════
    // DOM FINDERS — robust selectors for Google Flow
    // ══════════════════════════════════════════════════
    const DOM = {
        // Find the main prompt textarea / contenteditable
        getPromptInput() {
            return document.querySelector('textarea[aria-label*="prompt" i]')
                || document.querySelector('textarea[aria-label*="Prompt" i]')
                || document.querySelector('textarea[placeholder*="prompt" i]')
                || document.querySelector('textarea[placeholder*="Describe" i]')
                || document.querySelector('div[contenteditable="true"][role="textbox"]')
                || document.querySelector('textarea');
        },

        findButtonByText(text) {
            // Priority 1: Semantic common interactive elements
            const primary = document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], a');
            for (const el of primary) {
                const t = (el.textContent || el.innerText || '').trim().toLowerCase();
                if (t === text.toLowerCase() || (t.length > 0 && t.includes(text.toLowerCase()))) return el;
            }
            
            // Priority 2: Labels and Tooltips
            const labeled = document.querySelector(`[aria-label*="${text}" i], [title*="${text}" i], [data-tooltip*="${text}" i]`);
            if (labeled) return labeled;

            // Priority 3: Visual text in small containers (tabs/spans)
            const containers = document.querySelectorAll('span, div');
            for (const el of containers) {
                const t = (el.textContent || el.innerText || '').trim().toLowerCase();
                // Exact match for short text to avoid hitting large layout blocks
                if (t === text.toLowerCase() && t.length < 20) {
                    if (el.offsetWidth > 0 || el.offsetHeight > 0) return el;
                }
            }
            return null;
        },

        getGenerateButton() {
            return this.findButtonByText('Generate') || this.findButtonByText('Run') || this.findButtonByText('Create');
        },

        getDownloadButton() {
            return document.querySelector('a[download]')
                || this.findButtonByText('Download')
                || document.querySelector('button[aria-label*="Download" i]');
        },

        getFileInput() {
            return document.querySelector('input[type="file"]');
        },

        // Check for active error dialogs or toast messages
        getErrorText() {
            // Only look in likely active error containers to avoid spotting old messages
            const containers = document.querySelectorAll('[role="alert"], [role="status"], .toast, .snackbar, .error-box, .status-bar');
            for (const el of containers) {
                const text = el.innerText.toLowerCase();
                if (text.includes("policy") && text.includes("error")) return "Policy Error";
                if (text.includes("busy") || text.includes("server")) return "Server Busy";
                if (text.includes("rate limit")) return "Rate Limited";
                if (text.includes("failed to generate") || text.includes("something went wrong")) return "Generation Failed";
            }
            return null;
        }
    };

    // ══════════════════════════════════════════════════
    // AUTOMATION ENGINE
    // ══════════════════════════════════════════════════

    // React 16+ Native Value Setter
    function setNativeValue(element, value) {
        const desc = Object.getOwnPropertyDescriptor(element, 'value');
        const proto = Object.getPrototypeOf(element);
        const protoDesc = Object.getOwnPropertyDescriptor(proto, 'value');

        const setter = desc ? desc.set : null;
        const protoSetter = protoDesc ? protoDesc.set : null;

        if (protoSetter && setter !== protoSetter) {
            protoSetter.call(element, value);
        } else if (setter) {
            setter.call(element, value);
        } else {
            element.value = value;
        }
    }

    async function injectPromptText(text) {
        // Wait up to 30s for prompt input to appear on page
        let el = null;
        for (let i = 0; i < 30; i++) {
            el = DOM.getPromptInput();
            if (el) break;
            console.log('[FLOW] Waiting for prompt input... (' + (i+1) + '/30)');
            await wait(1);
        }
        if (!el) throw { type: 'retryable', message: 'Prompt input not found after 30s' };

        el.focus();
        
        try {
            // Apply native setter for React
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                setNativeValue(el, text);
            } else {
                el.textContent = text;
            }
        } catch(e) {
            // Fallback
            el.value = text;
        }

        // Trigger all possible framework event listeners
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
        el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
        
        await wait(0.5);
    }

    async function injectFiles(files) {
        if (!files || files.length === 0) return;
        const fileInput = DOM.getFileInput();
        if (!fileInput) {
            console.warn("[FLOW] No file input found on page — skipping file injection");
            return;
        }
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        
        // Native setter for files array in React
        try {
            const fileSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "files").set;
            fileSetter.call(fileInput, dt.files);
        } catch(e) {
            fileInput.files = dt.files;
        }

        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(2);
    }

    async function clickGenerate() {
        // Wait up to 20s for generate button to appear
        let btn = null;
        for (let i = 0; i < 20; i++) {
            btn = DOM.getGenerateButton();
            if (btn) break;
            console.log('[FLOW] Waiting for Generate button... (' + (i+1) + '/20)');
            await wait(1);
        }
        if (!btn) throw { type: 'retryable', message: 'Generate button not found after 20s' };

        // Wait for button to become enabled
        let tries = 0;
        while (btn.disabled && tries < 15) {
            await wait(1);
            tries++;
        }
        if (btn.disabled) throw { type: 'retryable', message: 'Generate button stayed disabled' };

        btn.click();
        await wait(1);
    }

    function waitForCompletion(timeoutSec = 900) {
        return new Promise((resolve, reject) => {
            let elapsed = 0;
            const interval = 5; // check every 5s

            const checker = setInterval(() => {
                elapsed += interval;

                // Check for download button (success)
                const dlBtn = DOM.getDownloadButton();
                if (dlBtn) {
                    clearInterval(checker);
                    resolve(dlBtn);
                    return;
                }

                // Check for errors
                const err = DOM.getErrorText();
                if (err === "Policy Error") {
                    clearInterval(checker);
                    reject({ type: "policy", message: err });
                    return;
                }
                if (err) {
                    clearInterval(checker);
                    reject({ type: "retryable", message: err });
                    return;
                }

                if (elapsed >= timeoutSec) {
                    clearInterval(checker);
                    reject({ type: "timeout", message: "Generation timed out" });
                }
            }, interval * 1000);
        });
    }

    async function triggerDownload(task, dlBtn) {
        const isVideo = task.mode.includes('v');
        const quality = isVideo ? settings.downloadVideoQuality : settings.downloadImageQuality;
        const ext = isVideo ? 'mp4' : 'png';

        if (quality === "No Download") return;

        let url = '';
        if (dlBtn.href) {
            url = dlBtn.href;
        } else if (dlBtn.tagName === 'A') {
            url = dlBtn.getAttribute('href') || '';
        }

        // If no direct URL, try clicking and hope browser handles it
        if (!url) {
            dlBtn.click();
            return;
        }

        chrome.runtime.sendMessage({
            action: "download",
            url: url,
            filename: `escena_${String(task.sequence || 1).padStart(3, '0')}.${ext}`,
            projectName: settings.projectName,
            quality: quality
        });
    }

    async function executeTask(task) {
        task.status = 'running';
        task.retries = task.retries || 0;
        activeRuns++;
        renderQueue();

        let success = false;
        while (!success && task.retries <= (settings.maxRetries || 20)) {
            try {
                // 1. Switch Mode (Video / Image) — Forceful tab clicking
                const isVideo = task.mode.includes('v');
                const targetModeText = isVideo ? 'Video' : 'Image';
                console.log(`[FLOW] Switching to ${targetModeText} mode...`);
                
                let modeBtn = DOM.findButtonByText(targetModeText);
                
                // Extra check for case where it's a tab list
                if (!modeBtn) {
                     const tabs = Array.from(document.querySelectorAll('[role="tab"], .tab, .mode-selector'));
                     modeBtn = tabs.find(t => (t.innerText||'').toLowerCase().includes(targetModeText.toLowerCase()));
                }

                if (modeBtn) {
                    modeBtn.click();
                    await wait(2); // Wait longer for mode switch
                } else {
                    console.warn(`[FLOW] Could not find ${targetModeText} mode button on page.`);
                }

                // 2. Set Aspect Ratio
                const aspectBtn = DOM.findButtonByText(settings.defaultAspect);
                if (aspectBtn) {
                    aspectBtn.click();
                    await wait(0.5);
                }

                // 3. Set Model
                const modelId = isVideo ? settings.videoModel : settings.imageModel;
                const modelMap = {
                    'veo_3_1_fast': 'Veo 3.1',
                    'veo_3_1_quality': 'Quality',
                    'nano_banana_2': 'Nano Banana 2',
                    'nano_banana_pro': 'Pro',
                    'imagen_4': 'Imagen 4'
                };
                const modelText = modelMap[modelId];
                if (modelText) {
                    const mBtn = DOM.findButtonByText(modelText);
                    if (mBtn) {
                        mBtn.click();
                        await wait(0.5);
                    }
                }

                // 4. Set Outputs Count
                const outBtn = DOM.findButtonByText(`${settings.outputsPerPrompt}`);
                if (outBtn) {
                    outBtn.click();
                    await wait(0.5);
                }

                await wait(1); // Final pause for UI stability

                // 5. Inject files if mode requires
                if (['i2v', 'c2v', 'i2i'].includes(task.mode) && task.files.length > 0) {
                    await injectFiles(task.files);
                }

                // Inject prompt text
                await injectPromptText(task.text);

                // Track potentially billed generations; never automatically re-submit uncertain results.
                await clickGenerate();
                task.sentToFlow = true;
                renderQueue();

                // Wait for result
                const dlBtn = await waitForCompletion(600);

                // Download
                await triggerDownload(task, dlBtn);

                task.status = 'done';
                success = true;

            } catch (err) {
                const errObj = typeof err === 'object' ? err : { type: 'unknown', message: String(err) };

                if (errObj.type === 'policy') {
                    task.status = 'skipped';
                    task.error = errObj.message;
                    console.warn(`[FLOW] Skipping (policy): "${task.text.substring(0, 30)}..."`);
                    success = true; // Don't retry policy errors
                } else if (task.sentToFlow) {
                    task.status = 'interrupted';
                    task.error = 'Ya se envió a Flow. Comprueba el resultado antes de repetir.';
                    success = true;
                } else {
                    task.retries++;
                    task.error = errObj.message;
                    console.warn(`[FLOW] Retry ${task.retries}/${settings.maxRetries}: ${errObj.message}`);
                    if (task.retries > (settings.maxRetries || 20)) {
                        task.status = 'failed';
                        success = true;
                    } else {
                        task.status = 'retrying';
                        renderQueue();
                        await wait(30); // Wait 30s between retries
                    }
                }
            }
        }

        activeRuns--;
        renderQueue();
    }

    async function automationLoop() {
        while (isRunning) {
            const pending = queue.find(q => q.status === 'pending');

            if (pending && activeRuns < 1) {
                executeTask(pending); // fire-and-forget async (parallel if slots open)
                const delay = rDelay();
                console.log(`[FLOW] Next prompt in ${delay}s`);
                await wait(delay);
            } else if (!pending && activeRuns === 0) {
                isRunning = false;
                console.log("[FLOW] All tasks completed.");
            } else {
                await wait(3);
            }
        }
        renderQueue();
    }

    // ══════════════════════════════════════════════════
    // SHADOW DOM UI
    // ══════════════════════════════════════════════════

    const L = (key) => (Flow.Locales[settings.language] || Flow.Locales.en)[key] || key;

    const ICONS = {
        logo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        sliders: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
        gear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        bolt: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        cloud: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
        doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        upload: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
        pic: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        grid: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
        star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        swap: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
    };

    function buildCSS() {
        return `
        :host{all:initial;font-family:'Inter',system-ui,sans-serif;}
        *{margin:0;padding:0;box-sizing:border-box;}
        ::-webkit-scrollbar{width:8px}::-webkit-scrollbar-track{background:#111}::-webkit-scrollbar-thumb{background:#444;border-radius:4px}
        #flow-wrap{display:flex;height:100%;}
        .resize-handle{width:7px;min-width:7px;cursor:col-resize;background:#1a1a1a;border-right:1px solid #27272a;transition:background .15s;flex-shrink:0;}
        .resize-handle:hover,.resize-handle.dragging{background:#2dd4bf;}
        #flow{background:#0f0f0f;color:#e5e7eb;height:100%;flex:1;display:flex;flex-direction:column;font-size:15px;border-left:none;border-right:none;border-top:1px solid #27272a;border-bottom:1px solid #27272a;box-shadow:-4px 0 24px rgba(0,0,0,.4);overflow:hidden;}
        .head{padding:18px 20px;border-bottom:1px solid #27272a;display:flex;justify-content:space-between;align-items:flex-start;}
        .head-left{display:flex;flex-direction:column;gap:4px;}
        .h-title{display:flex;align-items:center;gap:8px;font-weight:700;font-size:18px;color:#fff;}
        .badge{background:#eab308;color:#000;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:800;}
        .h-sub{font-size:13px;color:#6b7280;}
        .head-right{display:flex;align-items:center;gap:10px;}
        .lang{background:transparent;color:#d1d5db;border:1px solid #374151;padding:4px 10px;border-radius:6px;font-size:13px;outline:none;cursor:pointer;}
        .lang option{background:#1f2937;}

        .tabs{display:flex;gap:0;border-bottom:1px solid #27272a;}
        .tab{flex:1;background:transparent;color:#6b7280;border:none;padding:14px 0;cursor:pointer;font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:center;gap:6px;border-bottom:2px solid transparent;transition:.15s;}
        .tab:hover{color:#d1d5db;}
        .tab.on{color:#2dd4bf;border-bottom-color:#2dd4bf;}

        .body{flex:1;overflow-y:auto;padding:20px;}
        .pane{display:none;flex-direction:column;gap:18px;}
        .pane.on{display:flex;}

        .modes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
        .mbtn{background:#1f2937;color:#9ca3af;border:1px solid #374151;border-radius:8px;padding:10px 6px;cursor:pointer;text-align:center;font-size:13px;display:flex;align-items:center;justify-content:center;gap:6px;transition:.15s;font-weight:500;}
        .mbtn:hover{border-color:#4b5563;color:#fff;}
        .mbtn.on{background:#2dd4bf;color:#000;border-color:#2dd4bf;font-weight:700;}

        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
        .box{border:1px solid #27272a;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px;}
        .box-t{display:flex;align-items:center;gap:6px;font-weight:600;font-size:14px;color:#f3f4f6;}
        .box-s{font-size:12px;color:#6b7280;line-height:1.4;}
        .drow{display:flex;align-items:center;gap:8px;}

        .inp,.sel,.ta{background:#111827;border:1px solid #374151;color:#fff;padding:10px 12px;width:100%;box-sizing:border-box;border-radius:6px;font-size:14px;outline:none;font-family:inherit;}
        .inp:focus,.sel:focus,.ta:focus{border-color:#2dd4bf;}
        .ta{resize:vertical;min-height:100px;}
        .sel option{background:#1f2937;}

        .uzone{border:1px dashed #4b5563;border-radius:10px;padding:28px 16px;text-align:center;cursor:pointer;transition:.2s;display:flex;flex-direction:column;align-items:center;gap:8px;}
        .uzone:hover{border-color:#2dd4bf;background:#111827;}
        .uz-t{font-weight:600;font-size:14px;color:#d1d5db;}
        .uz-s{font-size:12px;color:#6b7280;}

        .hrow{display:flex;justify-content:space-between;align-items:center;}
        .hrow label{display:flex;align-items:center;gap:6px;font-weight:600;font-size:14px;color:#f3f4f6;}
        .txtbtn{background:transparent;border:none;color:#6b7280;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:5px;padding:0;}
        .txtbtn:hover{color:#fff;}

        .btn{width:100%;padding:14px;border:none;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer;transition:.15s;text-align:center;}
        .btn-primary{background:#2dd4bf;color:#000;}.btn-primary:hover{filter:brightness(1.1);}
        .btn-secondary{background:#374151;color:#fff;}.btn-secondary:hover{background:#4b5563;}
        .btn-danger{background:#ef4444;color:#fff;}.btn-danger:hover{background:#dc2626;}
        .btn:disabled{opacity:.4;cursor:not-allowed;}

        .qi{background:#111827;border:1px solid #1f2937;border-radius:10px;padding:14px;margin-bottom:8px;display:flex;flex-direction:column;gap:10px;font-size:13px;transition:.15s;}
        .qi:hover{border-color:#374151;}
        .qi-main{display:flex;justify-content:space-between;align-items:center;width:100%;gap:10px;}
        .qi .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;color:#d1d5db;font-weight:500;}
        .qi .s{font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;text-transform:uppercase;flex-shrink:0;}
        .qi-thumbs{display:flex;gap:6px;flex-wrap:wrap;}
        .qi-thumb{width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #374151;transition:.15s;}
        .qi-thumb:hover{border-color:#2dd4bf;transform:scale(1.1);z-index:2;}
        .qrm{background:transparent;border:none;color:#6b7280;cursor:pointer;font-size:18px;padding:0;line-height:1;transition:.1s;display:flex;align-items:center;justify-content:center;}
        .qrm:hover{color:#ef4444;transform:scale(1.2);}
        .s-pending{background:#374151;color:#9ca3af;}
        .s-running{background:#eab308;color:#000;}
        .s-done{background:#2dd4bf;color:#000;}
        .s-failed{background:#ef4444;color:#fff;}
        .s-skipped{background:#6b7280;color:#fff;}
        .s-retrying{background:#f59e0b;color:#000;}
        .qrm{background:none;border:none;color:#6b7280;cursor:pointer;font-size:18px;padding:0 4px;}.qrm:hover{color:#ef4444;}

        .sep{border:0;border-top:1px solid #1f2937;margin:6px 0;}
        .stat{display:flex;justify-content:space-between;align-items:center;font-size:14px;color:#9ca3af;padding:10px 0;}
        .stat strong{color:#fff;}

        .preview-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:8px;margin-top:10px;}
        .preview-item{position:relative;border-radius:6px;overflow:hidden;border:1px solid #374151;background:#111827;}
        .preview-item img{width:100%;height:70px;object-fit:cover;display:block;}
        .preview-info{padding:4px 6px;font-size:10px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .preview-rm{position:absolute;top:2px;right:2px;background:rgba(0,0,0,.7);color:#ef4444;border:none;cursor:pointer;font-size:14px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;padding:0;}
        .preview-rm:hover{background:#ef4444;color:#fff;}
        .file-count{font-size:12px;color:#9ca3af;margin-top:6px;}
        .sort-row{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px;color:#6b7280;}
        .sort-btn{background:transparent;border:1px solid #374151;color:#9ca3af;padding:2px 8px;border-radius:4px;cursor:pointer;transition:.1s;}
        .sort-btn:hover{border-color:#2dd4bf;color:#fff;}
        .preview-item.dragging{opacity:0.4;border-color:#2dd4bf;border-style:dashed;}
        .ipp-row{display:flex;align-items:center;gap:8px;margin-top:8px;}
        .ipp-row label{font-size:13px;color:#d1d5db;font-weight:500;}
        
        `;
    }

    function buildHTML() {
        const currentMode = settings.defaultMode || 't2v';
        return `
        <div id="flow-wrap">
            <div class="resize-handle" id="xResize"></div>
            <div id="flow">
            <div class="head">
                <div class="head-left">
                    <div class="h-title">${ICONS.logo} Flow Automation <span class="badge">v1.0</span></div>
                    <div class="h-sub">Create batch videos and images on Google Flow.</div>
                </div>
                <div class="head-right">
                    <select class="lang" id="xLang">
                        <option value="en" ${settings.language==='en'?'selected':''}>English</option>
                        <option value="es" ${settings.language==='es'?'selected':''}>Español</option>
                        <option value="vi">Tiếng Việt</option>
                        <option value="zh">中文</option>
                    </select>
                </div>
            </div>

            <div class="tabs">
                <button class="tab on" data-p="pControl">${ICONS.sliders} <span data-l="control">${L('control')}</span></button>
                <button class="tab" data-p="pQueue">${ICONS.doc} <span data-l="queue">${L('queue')}</span> (<span id="xQC">0</span>)</button>
                <button class="tab" data-p="pSettings">${ICONS.gear} <span data-l="settings">${L('settings')}</span></button>
            </div>

            <div class="body">
                <!-- ═══ CONTROL ═══ -->
                <div class="pane on" id="pControl">
                    <div class="modes">
                        <button class="mbtn ${currentMode==='t2v'?'on':''}" data-m="t2v">${ICONS.doc} ${L('t2v')}</button>
                        <button class="mbtn ${currentMode==='i2v'?'on':''}" data-m="i2v">${ICONS.pic} ${L('i2v')}</button>
                        <button class="mbtn ${currentMode==='c2v'?'on':''}" data-m="c2v">${ICONS.grid} ${L('c2v')}</button>
                        <button class="mbtn" data-m="t2i" style="grid-column:span 1">${ICONS.star} ${L('t2i')}</button>
                        <button class="mbtn" data-m="i2i" style="grid-column:span 2">${ICONS.pic} ${L('i2i')}</button>
                    </div>

                    <div class="grid2">
                        <div class="box">
                            <div class="box-t">${ICONS.bolt} ${L('concurrent')}</div>
                            <select class="sel" id="xConc">
                                <option value="1" selected>1 (seguro)</option>
                            </select>
                            <div class="box-s">${L('concurrentSub')}</div>
                        </div>
                        <div class="box">
                            <div class="box-t">${ICONS.clock} ${L('delay')}</div>
                            <div class="drow">
                                <input type="number" class="inp" id="xDMin" value="${settings.delayMin||20}" min="0" max="300">
                                ${ICONS.swap}
                                <input type="number" class="inp" id="xDMax" value="${settings.delayMax||30}" min="0" max="300">
                            </div>
                            <div class="box-s">${L('delaySub')}</div>
                        </div>
                    </div>

                    <div class="box" id="xUploadBox" style="display:${['i2v','c2v','i2i'].includes(currentMode)?'flex':'none'}">
                        <div class="uzone" id="xDropZone">
                            <input type="file" id="xFiles" multiple accept="image/png,image/jpeg,image/gif" style="display:none">
                            ${ICONS.cloud}
                            <div class="uz-t">${L('uploadTitle')}</div>
                            <div class="uz-s">${L('uploadSub')}</div>
                        </div>
                        <div id="xPreviews" class="preview-grid"></div>
                        <div class="sort-row" id="xSortRow" style="display:none">
                            <span>Sort by:</span>
                            <button class="sort-btn" id="xSortName">Name</button>
                            <button class="sort-btn" id="xSortDate">Date</button>
                        </div>
                        <div id="xFileCount" class="file-count"></div>
                        <div class="ipp-row" id="xIppRow" style="display:${currentMode==='i2v'?'flex':'none'}">
                            <label>${ICONS.pic} Images per prompt:</label>
                            <select class="sel" id="xIpp" style="width:auto;min-width:80px;">
                                <option value="1" ${(settings.maxImagesPerPrompt||2)==1?'selected':''}>1 image</option>
                                <option value="2" ${(settings.maxImagesPerPrompt||2)==2?'selected':''}>2 images</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <div class="hrow">
                            <label>${ICONS.doc} ${L('promptLabel')}</label>
                            <button class="txtbtn" id="xTxtBtn">${L('txtUpload')} ${ICONS.upload}</button>
                            <input type="file" id="xTxt" accept=".txt" style="display:none">
                        </div>
                        <textarea class="ta" id="xPrompts" placeholder="A serene sunset over a calm ocean...&#10;&#10;A bustling city street at night..." style="margin-top:6px;"></textarea>
                    </div>

                    <button class="btn btn-secondary" id="xAdd">${L('addQueue')}</button>

                    <hr class="sep">
                    <div class="stat">
                        <span>Status: <strong id="xStatus">${L('ready')}</strong></span>
                        <span>Active: <strong id="xActive">0</strong></span>
                    </div>
                    <button class="btn btn-primary" id="xRun">${L('start')}</button>
                    <button class="btn btn-danger" id="xStop" style="display:none">${L('stop')}</button>
                </div>

                <!-- ═══ QUEUE ═══ -->
                <div class="pane" id="pQueue">
                    <div class="hrow" style="margin-bottom:8px;">
                        <label>${L('queue')}</label>
                        <button class="txtbtn" id="xClear" style="color:#ef4444;">${L('clearQueue')}</button>
                    </div>
                    <div id="xQList"></div>
                </div>

                <!-- ═══ SETTINGS ═══ -->
                <div class="pane" id="pSettings">
                    <div class="box">
                        <label style="font-size:11px;color:#9ca3af;">${L('projectName')}</label>
                        <input type="text" class="inp" id="xProj" value="${settings.projectName||'flow_project'}">
                    </div>
                    <div class="grid2">
                        <div class="box">
                            <label style="font-size:11px;color:#9ca3af;">${L('aspectRatio')}</label>
                            <select class="sel" id="xAspect">
                                <option ${settings.defaultAspect==='16:9'?'selected':''}>16:9</option>
                                <option ${settings.defaultAspect==='9:16'?'selected':''}>9:16</option>
                                <option ${settings.defaultAspect==='1:1'?'selected':''}>1:1</option>
                                <option ${settings.defaultAspect==='4:3'?'selected':''}>4:3</option>
                                <option ${settings.defaultAspect==='3:4'?'selected':''}>3:4</option>
                            </select>
                        </div>
                        <div class="box">
                            <label style="font-size:11px;color:#9ca3af;">${L('outputsPerPrompt')}</label>
                            <select class="sel" id="xOutputs">
                                ${[1,2,3,4].map(n => `<option value="${n}" ${n==settings.outputsPerPrompt?'selected':''}>${n}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <div class="grid2">
                        <div class="box">
                            <label style="font-size:11px;color:#9ca3af;">${L('videoModel')}</label>
                            <select class="sel" id="xVModel">
                                <option value="veo_3_1_fast" ${settings.videoModel==='veo_3_1_fast'?'selected':''}>Veo 3.1 - Fast</option>
                                <option value="veo_3_1_quality" ${settings.videoModel==='veo_3_1_quality'?'selected':''}>Veo 3.1 - Quality</option>
                            </select>
                        </div>
                        <div class="box">
                            <label style="font-size:11px;color:#9ca3af;">${L('imageModel')}</label>
                            <select class="sel" id="xIModel">
                                <option value="nano_banana_2" ${settings.imageModel==='nano_banana_2'?'selected':''}>Nano Banana 2</option>
                                <option value="nano_banana_pro" ${settings.imageModel==='nano_banana_pro'?'selected':''}>Nano Banana Pro</option>
                                <option value="imagen_4" ${settings.imageModel==='imagen_4'?'selected':''}>Imagen 4</option>
                            </select>
                        </div>
                    </div>
                    <div class="grid2">
                        <div class="box">
                            <label style="font-size:11px;color:#9ca3af;">${L('dlVideo')}</label>
                            <select class="sel" id="xDLV">
                                <option ${settings.downloadVideoQuality==='1080p'?'selected':''}>1080p</option>
                                <option ${settings.downloadVideoQuality==='720p'?'selected':''}>720p</option>
                                <option ${settings.downloadVideoQuality==='No Download'?'selected':''}>No Download</option>
                            </select>
                        </div>
                        <div class="box">
                            <label style="font-size:11px;color:#9ca3af;">${L('dlImage')}</label>
                            <select class="sel" id="xDLI">
                                <option ${settings.downloadImageQuality==='4k'?'selected':''}>4k</option>
                                <option ${settings.downloadImageQuality==='2k'?'selected':''}>2k</option>
                                <option ${settings.downloadImageQuality==='1k'?'selected':''}>1k</option>
                                <option ${settings.downloadImageQuality==='No Download'?'selected':''}>No Download</option>
                            </select>
                        </div>
                    </div>
                    <div class="box">
                        <label style="font-size:11px;color:#9ca3af;">${L('maxRetries')}</label>
                        <input type="number" class="inp" id="xRetries" value="${settings.maxRetries||20}" min="1" max="20">
                    </div>
                    <button class="btn btn-primary" id="xSave">${L('saveSettings')}</button>
                    <div style="font-size:10px;color:#4b5563;text-align:center;margin-top:4px;">${L('zoomNote')}</div>
                </div>
            </div>
        </div>
        </div>`;
    }

    // ══════════════════════════════════════════════════
    // RENDER QUEUE
    // ══════════════════════════════════════════════════
    function renderQueue() {
        saveQueue();
        if (!shadowRef) return;
        const list = shadowRef.getElementById('xQList');
        const countEl = shadowRef.getElementById('xQC');
        const statusEl = shadowRef.getElementById('xStatus');
        const activeEl = shadowRef.getElementById('xActive');
        const runBtn = shadowRef.getElementById('xRun');
        const stopBtn = shadowRef.getElementById('xStop');

        if (countEl) countEl.textContent = queue.filter(q => q.status === 'pending').length;
        if (statusEl) statusEl.textContent = isRunning ? L('running') : (activeRuns ? 'Finalizando tarea' : L('idle'));
        if (activeEl) activeEl.textContent = activeRuns;
        if (runBtn) runBtn.style.display = (isRunning || activeRuns > 0) ? 'none' : 'block';
        if (stopBtn) stopBtn.style.display = isRunning ? 'block' : 'none';

        if (!list) return;
        list.innerHTML = queue.map(q => {
            const safeText = Flow.escapeHTML(q.text);
            const hasFiles = q.files && q.files.length > 0;
            const fileThumbs = hasFiles ? `
                <div class="qi-thumbs">
                    ${q.files.map(f => `<img src="${URL.createObjectURL(f)}" class="qi-thumb" title="${Flow.escapeHTML(f.name)}">`).join('')}
                </div>
            ` : '';

            return `
                <div class="qi">
                    <div class="qi-main">
                        <span class="t" title="${safeText}">[${q.mode.toUpperCase()}] ${safeText}</span>
                        <div style="display:flex;align-items:center;gap:10px;">
                            <span class="s s-${q.status}">${q.status}${q.retries > 0 ? ' ('+q.retries+')' : ''}</span>
                            ${q.status === 'pending' ? `<button class="qrm" data-rm="${q.id}">×</button>` : ''}
                        </div>
                    </div>
                    ${fileThumbs}
                </div>
            `;
        }).join('');

        // Attach remove listeners
        list.querySelectorAll('.qrm').forEach(btn => {
            btn.addEventListener('click', () => {
                queue = queue.filter(q => q.id !== btn.dataset.rm);
                renderQueue();
            });
        });
    }

    // ══════════════════════════════════════════════════
    // FILE MANAGEMENT & PREVIEW
    // ══════════════════════════════════════════════════
    function addFiles(newFiles, s) {
        newFiles.forEach(f => {
            // Avoid duplicates by name+size
            if (!uploadedFiles.some(e => e.name === f.name && e.size === f.size)) {
                uploadedFiles.push(f);
            }
        });
        renderPreviews(s);
    }
    function renderPreviews(s) {
        const grid = s.getElementById('xPreviews');
        const countEl = s.getElementById('xFileCount');
        const sortRow = s.getElementById('xSortRow');
        if (!grid) return;

        if (uploadedFiles.length === 0) {
            grid.innerHTML = '';
            if (countEl) countEl.textContent = '';
            if (sortRow) sortRow.style.display = 'none';
            return;
        }

        if (countEl) countEl.textContent = `${uploadedFiles.length} file${uploadedFiles.length > 1 ? 's' : ''} selected`;
        if (sortRow) sortRow.style.display = 'flex';

        grid.innerHTML = uploadedFiles.map((f, i) => {
            const sizeKB = (f.size / 1024).toFixed(0);
            return `
                <div class="preview-item" data-idx="${i}" draggable="true">
                    <img src="${URL.createObjectURL(f)}" alt="${Flow.escapeHTML(f.name)}">
                    <div class="preview-info" title="${Flow.escapeHTML(f.name)}">${Flow.escapeHTML(f.name)} (${sizeKB}KB)</div>
                    <button class="preview-rm" data-rm="${i}">×</button>
                </div>`;
        }).join('');

        // Attach remove buttons
        grid.querySelectorAll('.preview-rm').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.rm);
                uploadedFiles.splice(idx, 1);
                renderPreviews(s);
            });
        });

        // Sorting Logic
        const sortName = s.getElementById('xSortName');
        const sortDate = s.getElementById('xSortDate');
        if (sortName && !sortName.dataset.bound) {
            sortName.dataset.bound = "true";
            sortName.addEventListener('click', () => {
                uploadedFiles.sort((a, b) => a.name.localeCompare(b.name));
                renderPreviews(s);
            });
        }
        if (sortDate && !sortDate.dataset.bound) {
            sortDate.dataset.bound = "true";
            sortDate.addEventListener('click', () => {
                uploadedFiles.sort((a, b) => b.lastModified - a.lastModified);
                renderPreviews(s);
            });
        }

        // Drag & Drop Logic
        grid.querySelectorAll('.preview-item').forEach(el => {
            el.addEventListener('dragstart', () => {
                draggedIdx = parseInt(el.dataset.idx);
                el.classList.add('dragging');
            });
            el.addEventListener('dragend', () => el.classList.remove('dragging'));
            el.addEventListener('dragover', e => e.preventDefault());
            el.addEventListener('drop', e => {
                e.preventDefault();
                const targetIdx = parseInt(el.dataset.idx);
                if (draggedIdx !== null && draggedIdx !== targetIdx) {
                    const item = uploadedFiles.splice(draggedIdx, 1)[0];
                    uploadedFiles.splice(targetIdx, 0, item);
                    renderPreviews(s);
                }
                draggedIdx = null;
            });
        });
    }

    // ══════════════════════════════════════════════════
    // WIRE EVENTS
    // ══════════════════════════════════════════════════
    let currentMode = 't2v';

    function wireEvents(s) {
        // Prevent host page from stealing keyboard events (Backspace, Delete, etc.)
        s.addEventListener('keydown', (e) => {
            e.stopPropagation();
        }, { capture: true });

        // Tabs
        s.querySelectorAll('.tab').forEach(t => {
            t.addEventListener('click', () => {
                s.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
                s.querySelectorAll('.pane').forEach(x => x.classList.remove('on'));
                t.classList.add('on');
                s.getElementById(t.dataset.p).classList.add('on');
            });
        });

        // Modes
        s.querySelectorAll('.mbtn').forEach(b => {
            b.addEventListener('click', () => {
                s.querySelectorAll('.mbtn').forEach(x => x.classList.remove('on'));
                b.classList.add('on');
                currentMode = b.dataset.m;
                s.getElementById('xUploadBox').style.display = ['i2v','c2v','i2i'].includes(currentMode) ? 'flex' : 'none';
                s.getElementById('xIppRow').style.display = currentMode === 'i2v' ? 'flex' : 'none';
            });
        });

        // Drop zone
        const dz = s.getElementById('xDropZone');
        const fi = s.getElementById('xFiles');
        dz.addEventListener('click', (e) => { if (e.target === dz || e.target.closest('.uzone')) fi.click(); });
        dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor = '#2dd4bf'; });
        dz.addEventListener('dragleave', () => { dz.style.borderColor = '#4b5563'; });
        dz.addEventListener('drop', e => {
            e.preventDefault(); dz.style.borderColor = '#4b5563';
            addFiles(Array.from(e.dataTransfer.files), s);
        });
        fi.addEventListener('change', () => {
            addFiles(Array.from(fi.files), s);
            fi.value = ''; // Reset so same files can be re-selected
        });

        // Txt upload button
        const txtBtn = s.getElementById('xTxtBtn');
        const txtFile = s.getElementById('xTxt');
        txtBtn.addEventListener('click', () => txtFile.click());
        txtFile.addEventListener('change', () => {
            if (txtFile.files.length > 0) {
                txtBtn.innerHTML = txtFile.files[0].name + ' ' + ICONS.upload;
                txtBtn.style.color = '#2dd4bf'; // Highlight success
            }
        });

        // Add to queue
        s.getElementById('xAdd').addEventListener('click', async () => {
            const ta = s.getElementById('xPrompts');
            let raw = ta.value.trim();
            if (txtFile.files.length > 0) raw += "\n\n" + await txtFile.files[0].text();

            if (!raw) { alert(L('emptyPrompts')); return; }

            const prompts = Flow.parsePrompts(raw);
            const ipp = parseInt((s.getElementById('xIpp') || {}).value) || (settings.maxImagesPerPrompt || 2);

            prompts.forEach((p, idx) => {
                let matched = [];
                if (currentMode === 'c2v' || currentMode === 'i2i') {
                    matched = Flow.matchAssets(uploadedFiles, p);
                } else if (currentMode === 'i2v') {
                    // Distribute images across prompts based on images-per-prompt setting
                    const startIdx = idx * ipp;
                    matched = uploadedFiles.slice(startIdx, startIdx + ipp);
                }
                queue.push({ id: uid(), sequence: nextSequence++, mode: currentMode, text: p, files: matched, status: 'pending', retries: 0, error: '' });
            });

            ta.value = ''; 
            txtFile.value = '';
            txtBtn.innerHTML = L('txtUpload') + ' ' + ICONS.upload;
            txtBtn.style.color = '';
            renderQueue();
        });

        // Run / Stop
        s.getElementById('xRun').addEventListener('click', () => {
            if (!isInsideActualProject()) {
                alert("Please enter a Google Flow project first!\n\nYou can add to your queue here on the landing page, but to 'Run' the automation, you must click 'New Project' or open an existing project.");
                return;
            }
            if (queue.some(q => q.status === 'pending')) {
                isRunning = true;
                renderQueue();
                automationLoop();
            } else {
                alert("Queue is empty!\n\nPlease type a prompt into the text box and click 'Add to Queue' first.");
            }
        });
        s.getElementById('xStop').addEventListener('click', () => {
            isRunning = false;
            renderQueue();
        });

        // Clear queue
        s.getElementById('xClear').addEventListener('click', () => { 
            if (!isRunning) {
                queue = [];
                activeRuns = 0;
            } else {
                queue = queue.filter(q => q.status === 'running');
            }
            renderQueue(); 
        });

        // Settings save
        s.getElementById('xSave').addEventListener('click', async () => {
            settings.projectName = s.getElementById('xProj').value;
            settings.defaultAspect = s.getElementById('xAspect').value;
            settings.outputsPerPrompt = parseInt(s.getElementById('xOutputs').value);
            settings.videoModel = s.getElementById('xVModel').value;
            settings.imageModel = s.getElementById('xIModel').value;
            settings.downloadVideoQuality = s.getElementById('xDLV').value;
            settings.downloadImageQuality = s.getElementById('xDLI').value;
            settings.maxRetries = parseInt(s.getElementById('xRetries').value);
            await Flow.Storage.set('settings', settings);
        });

        // Live-save concurrent and delay
        ['xConc', 'xDMin', 'xDMax'].forEach(id => {
            s.getElementById(id).addEventListener('change', async () => {
                settings.maxConcurrent = parseInt(s.getElementById('xConc').value);
                settings.delayMin = parseInt(s.getElementById('xDMin').value);
                settings.delayMax = parseInt(s.getElementById('xDMax').value);
                await Flow.Storage.set('settings', settings);
            });
        });

        // Language
        s.getElementById('xLang').addEventListener('change', async (e) => {
            settings.language = e.target.value;
            await Flow.Storage.set('settings', settings);
            // Rebuild UI
            s.getElementById('flow-wrap').remove();
            s.querySelector('style').remove();
            buildAndMount(s);
        });

        // ─── Resize Handle ───
        const resizeHandle = s.getElementById('xResize');
        const hostEl = document.getElementById('flow-host');
        let isResizing = false;

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizeHandle.classList.add('dragging');
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const newWidth = window.innerWidth - e.clientX;
            const clamped = Math.max(320, Math.min(900, newWidth));
            hostEl.style.width = clamped + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizeHandle.classList.remove('dragging');
            }
        });
    }

    // ══════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════
    function buildAndMount(shadow) {
        const style = document.createElement('style');
        style.textContent = buildCSS();
        shadow.appendChild(style);
        const wrapper = document.createElement('div');
        wrapper.innerHTML = buildHTML();
        shadow.appendChild(wrapper.firstElementChild);
        shadowRef = shadow;
        wireEvents(shadow);
        renderQueue();
    }

    function isProjectPage() {
        const url = window.location.href;
        // Broaden to any flow page so the sidebar appears on landing page too
        return url.includes('/flow') || url.includes('/fx/tools/flow');
    }

    function isInsideActualProject() {
        const url = window.location.href;
        // Only true if we are deeper than the landing page
        return url.includes('/project/');
    }

    async function init() {
        if (document.getElementById('flow-host')) return;

        // Guard: only run on project pages
        if (!isProjectPage()) {
            console.log('[FLOW] Not a project page, skipping injection. URL:', window.location.href);
            return;
        }

        // Load settings
        const saved = await Flow.Storage.get('settings', Flow.DEFAULTS);
        settings = { ...Flow.DEFAULTS, ...saved };
        settings.maxConcurrent = 1;
        await loadQueue();
        currentMode = settings.defaultMode || 't2v';

        // No zoom override — keep native browser zoom for clarity

        // Create host
        const host = document.createElement('div');
        host.id = 'flow-host';
        host.style.cssText = 'position:fixed;top:0;right:0;width:480px;height:100vh;z-index:999999;';
        document.body.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });
        buildAndMount(shadow);
    }

    // Wait for page to be ready, then check periodically for SPA navigation
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

    // SPA navigation detection & persistence guard — re-check every 2s
    let lastUrl = window.location.href;
    setInterval(() => {
        const isProject = isProjectPage();
        const hostExists = !!document.getElementById('flow-host');

        // Force re-inject if sidebar was removed by Google's UI engine
        if (isProject && !hostExists) {
            console.log('[FLOW] Project page detected without sidebar. Initializing...');
            init();
        }

        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
        }
    }, 2000);
})();
