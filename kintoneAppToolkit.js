// ==UserScript==
// @name         kintone App Toolkit: Health Check + Field Inventory
// @namespace    https://example.com/
// @version      1.0.1
// @description  kintoneアプリのヘルスチェック（基準編集）とフィールド一覧（Markdown/備考つき）
// @match        https://*.cybozu.com/k/*/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=cybozu.com
// @run-at       document-idle
// @grant        none
// @license      MIT
// @updateURL    https://github.com/youtotto/kintone-app-toolkit/blob/4afb9a6b75a941e18c8fad27a2fdd10dc6f7f0ed/kintoneAppToolkit.js
// ==/UserScript==
(function () {
    'use strict';

    /** ----------------------------
   * readiness / api helpers
   * ---------------------------- */
    const appReady = () => typeof kintone !== 'undefined' && kintone.api && kintone.app;
    const waitReady = () => new Promise(res => {
        const t = setInterval(() => { if (appReady()) { clearInterval(t); res(); } }, 50);
        setTimeout(() => { clearInterval(t); res(); }, 10000);
    });
    const api = (path, params) => kintone.api(kintone.api.url(path, true), 'GET', params);
    const escHTML = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

    /** ----------------------------
   * CONSTANTS
   * ---------------------------- */
    const CONTAINER_TYPES = new Set(['GROUP', 'SUBTABLE', 'LABEL']);
    const SYSTEM_TYPES = new Set(['RECORD_NUMBER', 'CREATOR', 'CREATED_TIME', 'MODIFIER', 'UPDATED_TIME', 'STATUS', 'STATUS_ASSIGNEE']);

    // Health thresholds (edit-able; persisted to LS)
    const LS_TH_KEY = 'ktHealthThresholds.v1';
    const DEFAULT_TH = {
        totalFields: { Y: 100, R: 200, label: 'フォーム総フィールド数' },
        states: { Y: 10, R: 12, label: 'プロセス状態数' },
        actions: { Y: 15, R: 18, label: 'プロセスアクション数' }
    };
    const loadTH = () => {
        try {
            const j = JSON.parse(localStorage.getItem(LS_TH_KEY) || '{}');
            return Object.fromEntries(Object.keys(DEFAULT_TH).map(k => {
                const v = j[k] || {};
                return [k, { Y: Number(v.Y ?? DEFAULT_TH[k].Y), R: Number(v.R ?? DEFAULT_TH[k].R), label: DEFAULT_TH[k].label }];
            }));
        } catch { return structuredClone(DEFAULT_TH); }
    };
    const saveTH = th => localStorage.setItem(LS_TH_KEY, JSON.stringify(th));

    const judge = (val, { Y, R }) =>
        val >= R ? { level: 'RED', badge: '🔴' } :
            val >= Y ? { level: 'YELLOW', badge: '🟡' } :
                { level: 'OK', badge: '🟢' };

    /** ----------------------------
   * UI Root (tabs)
   * ---------------------------- */
    const mountRoot = () => {
        const wrap = document.createElement('div');
        wrap.id = 'kt-toolkit';
        wrap.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:99999;
      background:#111; color:#fff; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.35);
      font:12px/1.5 ui-sans-serif,system-ui; width:min(920px, 95vw); max-height:80vh; overflow:auto;
      border:1px solid #2a2a2a;
    `;
        wrap.innerHTML = `
      <style>
        #kt-toolkit .bar{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #2a2a2a;}
        #kt-toolkit .tabs{display:flex;gap:6px;flex-wrap:wrap}
        #kt-toolkit .tab{padding:6px 10px;border:1px solid #2a2a2a;background:#1d1d1d;color:#fff;border-radius:8px;cursor:pointer}
        #kt-toolkit .tab.active{background:#2563eb;border-color:#2563eb}
        #kt-toolkit .btn{padding:6px 10px;border:1px solid #2a2a2a;background:#1d1d1d;color:#fff;border-radius:8px;cursor:pointer}
        #kt-toolkit .body{padding:12px}
        #kt-toolkit table{border-collapse:collapse;width:100%}
        #kt-toolkit th{ text-align:left;padding:6px;border-bottom:1px solid #333;position:sticky;top:0;background:#111}
        #kt-toolkit td{ padding:6px;border-bottom:1px solid #222}
        /* 必須列（Fieldsプレビューの3列目）固定 */
        #kt-fields th:nth-child(3), #kt-fields td:nth-child(3){ min-width:64px; text-align:center; white-space:nowrap; }
      </style>
      <div class="bar">
        <div class="tabs">
          <button id="tab-health" class="tab active">Health</button>
          <button id="tab-fields" class="tab">Fields</button>
        </div>
        <div>
          <button id="kt-close" class="btn">×</button>
        </div>
      </div>
      <div class="body">
        <div id="view-health"></div>
        <div id="view-fields" style="display:none"></div>
      </div>
    `;
        document.body.appendChild(wrap);
        wrap.querySelector('#kt-close').addEventListener('click', () => wrap.remove(), { passive: true });
        const switchTab = (idShow) => {
            wrap.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
            wrap.querySelector('#tab-' + idShow).classList.add('active');
            wrap.querySelector('#view-health').style.display = idShow === 'health' ? 'block' : 'none';
            wrap.querySelector('#view-fields').style.display = idShow === 'fields' ? 'block' : 'none';
        };
        wrap.querySelector('#tab-health').addEventListener('click', () => switchTab('health'), { passive: true });
        wrap.querySelector('#tab-fields').addEventListener('click', () => switchTab('fields'), { passive: true });
        return wrap;
    };

    /** ----------------------------
   * Health view
   * ---------------------------- */
    const renderHealth = async (root, appId) => {
        let TH = loadTH();

        // fetch metrics (best-effort for optional endpoints)
        const [fields, status, views, notifs, customize, acl] = await Promise.all([
            api('/k/v1/app/form/fields', { app: appId }),
            api('/k/v1/app/status', { app: appId }),
            api('/k/v1/app/views', { app: appId }).catch(() => null),
            api('/k/v1/app/notifications/general.json', { app: appId }).catch(() => null),
            api('/k/v1/app/customize', { app: appId }).catch(() => null),
            api('/k/v1/app/acl', { app: appId }).catch(() => null),
        ]);

        const props = Object.values(fields.properties || {});
        const flatten = arr => arr.flatMap(p => p.type === 'SUBTABLE' ? [p, ...Object.values(p.fields)] : [p]);
        const list = flatten(props);
        const metrics = {
            totalFields: list.length,
            groups: list.filter(f => f.type === 'GROUP').length,
            subtables: list.filter(f => f.type === 'SUBTABLE').length,
            subtableColsMax: Math.max(0, ...props.filter(f => f.type === 'SUBTABLE').map(t => Object.keys(t.fields).length)),
            states: Object.keys(status.states || {}).length,
            actions: (status.actions || []).length,
            views: views ? Object.keys(views.views || {}).length : null,
            notifications: notifs ? (notifs.notifications || []).length : null,
            jsFiles: customize ? (customize.desktop.js || []).length : null,
            cssFiles: customize ? (customize.desktop.css || []).length : null,
            roles: acl ? (acl.rights || []).length : null
        };
        const score = {
            totalFields: judge(metrics.totalFields, TH.totalFields),
            states: judge(metrics.states, TH.states),
            actions: judge(metrics.actions, TH.actions),
        };

        const el = root.querySelector('#view-health');
        el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-weight:700">App Health（読み取り専用）</div>
        <div style="display:flex;gap:6px">
          <button id="kt-copy" class="btn">Copy</button>
          <button id="kt-th" class="btn">基準</button>
        </div>
      </div>

      <div id="kt-summary">
        <table style="max-width:480px;margin-bottom:8px">
          <tr><td>Fields</td><td>${metrics.totalFields} / Group: ${metrics.groups} / SubTable: ${metrics.subtables} (maxCols: ${metrics.subtableColsMax})</td></tr>
          <tr><td>States/Actions</td><td>${metrics.states} / ${metrics.actions}</td></tr>
          <tr><td>Views/Notifs</td><td>${metrics.views ?? '-'} / ${metrics.notifications ?? '-'}</td></tr>
          <tr><td>JS/CSS</td><td>${metrics.jsFiles ?? '-'} / ${metrics.cssFiles ?? '-'}</td></tr>
          <tr><td>ACL rules</td><td>${metrics.roles ?? '-'}</td></tr>
        </table>

        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div><strong>Fields</strong>：${score.totalFields.badge} ${score.totalFields.level}</div>
          <div><strong>States</strong>：${score.states.badge} ${score.states.level}</div>
          <div><strong>Actions</strong>：${score.actions.badge} ${score.actions.level}</div>
        </div>
      </div>

      <div id="kt-th-panel" style="display:none;margin-top:10px">
        <div style="opacity:.85;margin-bottom:6px">基準（しきい値）：Y=注意 / R=分割推奨。保存するとLocalStorageに記録されます。</div>
        <table style="max-width:520px">
          <thead>
            <tr><th>指標</th><th style="text-align:right">Y</th><th style="text-align:right">R</th></tr>
          </thead>
          <tbody id="kt-th-rows"></tbody>
        </table>
        <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end">
          <button id="kt-th-reset" class="btn">初期化</button>
          <button id="kt-th-save"  class="btn" style="background:#2563eb;border-color:#2563eb">保存</button>
        </div>
      </div>
    `;

        const rowsEl = el.querySelector('#kt-th-rows');
        const renderTHRows = () => {
            rowsEl.innerHTML = Object.entries(TH).map(([k, v]) => `
        <tr data-key="${k}">
          <td>${v.label}</td>
          <td style="text-align:right"><input type="number" min="0" value="${v.Y}"
            style="width:64px;background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:6px;padding:4px 6px"></td>
          <td style="text-align:right"><input type="number" min="0" value="${v.R}"
            style="width:64px;background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:6px;padding:4px 6px"></td>
        </tr>
      `).join('');
        };
        renderTHRows();

        const summaryText = `App ${appId}
           Fields: ${metrics.totalFields} (Group: ${metrics.groups}, SubTable: ${metrics.subtables}, maxCols:$ {metrics.subtableColsMax})
           States/Actions: ${metrics.states}/${metrics.actions}
           Views/Notifications: ${metrics.views}/${metrics.notifications}
           Customize JS/CSS: ${metrics.jsFiles}/${metrics.cssFiles}
           ACL rules: ${metrics.roles}
           判定: Fields=${score.totalFields.level}, States=${score.states.level}, Actions=${score.actions.level}`;

        el.querySelector('#kt-copy').addEventListener('click', async () => {
            await navigator.clipboard.writeText(summaryText);
            const b = el.querySelector('#kt-copy'); const old = b.textContent; b.textContent = 'Copied!';
            setTimeout(() => b.textContent = old, 1200);
        }, { passive: true });

        el.querySelector('#kt-th').addEventListener('click', () => {
            const p = el.querySelector('#kt-th-panel'), s = el.querySelector('#kt-summary');
            const show = p.style.display === 'none';
            p.style.display = show ? 'block' : 'none';
            s.style.display = show ? 'none' : 'block';
        }, { passive: true });

        el.querySelector('#kt-th-reset').addEventListener('click', () => {
            TH = loadTH(); renderTHRows();
        }, { passive: true });

        el.querySelector('#kt-th-save').addEventListener('click', () => {
            [...rowsEl.querySelectorAll('tr')].forEach(tr => {
                const key = tr.dataset.key;
                const [yEl, rEl] = tr.querySelectorAll('input');
                const Y = Math.max(0, Number(yEl.value || 0));
                const R = Math.max(0, Number(rEl.value || 0));
                TH[key].Y = Math.min(Y, R);
                TH[key].R = Math.max(R, Y);
            });
            saveTH(TH);
            const b = el.querySelector('#kt-th-save'); const old = b.textContent; b.textContent = '保存しました';
            setTimeout(() => b.textContent = old, 1200);
        }, { passive: true });
    };

    /** ----------------------------
   * Fields view (layout-aware, MD with notes)
   * ---------------------------- */
    const formatDefault = (f) => {
        if (f.defaultValue === undefined || f.defaultValue === null) return '';
        return Array.isArray(f.defaultValue) ? f.defaultValue.join(', ') : String(f.defaultValue);
    };
    const mdEsc = (v = '') =>
        String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');

    const toCSV = (rows) => [
        ['フィールド名', 'フィールドコード', '必須', '初期値', 'フィールド形式', 'グループ'].join(','),
        ...rows.map(r => [
            r.label, r.code, r.required ? 'TRUE' : 'FALSE', r.defaultValue, r.type, r.groupPath
        ].map(s => `"${String(s ?? '').replace(/"/g, '""')}"`).join(','))
    ].join('\r\n');

    const toMarkdownWithNotes = (rows) => {
        const header = ['フィールド名', 'フィールドコード', '必須', '初期値', 'フィールド形式', 'グループ', '備考'];
        const sep = header.map(() => ':-').join(' | ');
        const lines = rows.map(r => [
            mdEsc(r.label),
            mdEsc(r.code),
            r.required ? '✓' : '',
            mdEsc(r.defaultValue),
            mdEsc(r.type),
            mdEsc(r.groupPath),
            '' // 備考は空欄
        ].join(' | '));
        return [`| ${header.join(' | ')} |`, `| ${sep} |`, ...lines.map(l => `| ${l} |`)].join('\n');
    };

    const download = (filename, text, type = 'text/plain') => {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: filename });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    };

    const renderFields = async (root, appId) => {
        // ルックアップ判定を含めた型の正規化
        const normalizeType = (f) => {
            if (f && f.lookup) return 'LOOKUP';
            return f?.type ?? '';
        };
        // get field defs + layout (for group/subtable placement)
        const [fieldsResp, layoutResp] = await Promise.all([
            api('/k/v1/app/form/fields', { app: appId }),
            api('/k/v1/app/form/layout', { app: appId })
        ]);
        const props = fieldsResp.properties || {};
        const layout = layoutResp.layout || [];

        // build: 1) code -> groupPath map  2) layout order (codes as they appear)
        const groupPathByCode = {};
        const layoutOrderCodes = [];
        const walk = (nodes, curGroup = null) => {
            for (const n of nodes || []) {
                if (n.type === 'ROW') {
                    for (const f of n.fields || []) {
                        if (f.type === 'SUBTABLE') {
                            const stLabel = f.label || f.code || '(Subtable)';
                            for (const sf of f.fields || []) {
                                const parts = [];
                                if (curGroup) parts.push(`Group: ${curGroup}`);
                                parts.push(`Subtable: ${stLabel}`);
                                if (sf.code) {
                                    groupPathByCode[sf.code] = parts.join(' / ');
                                    layoutOrderCodes.push(sf.code);
                                }
                            }
                        } else if (f.code) {
                            const parts = [];
                            if (curGroup) parts.push(`Group: ${curGroup}`);
                            groupPathByCode[f.code] = parts.join(' / ');
                            layoutOrderCodes.push(f.code);
                        }
                    }
                } else if (n.type === 'GROUP') {
                    const gLabel = n.label || n.code || '(Group)';
                    walk(n.layout, gLabel);
                }
            }
        };
        walk(layout);

        // collect leaf fields from defs
        const list = [];
        const seen = new Set();
        const collect = f => {
            if (!f || !f.type) return;
            if (f.type === 'GROUP') Object.values(f.fields || {}).forEach(collect);
            else if (f.type === 'SUBTABLE') Object.values(f.fields || {}).forEach(collect);
            else if (!CONTAINER_TYPES.has(f.type) && f.code && !seen.has(f.code)) {
                seen.add(f.code);
                list.push({
                    label: f.label ?? '',
                    code: f.code ?? '',
                    required: !!f.required,
                    defaultValue: formatDefault(f),
                    type: normalizeType(f)
                });
            }
        };
        Object.values(props).forEach(collect);

        const rows = list
            .map(r => ({ ...r, groupPath: groupPathByCode[r.code] || '' }))
            .filter(r => !SYSTEM_TYPES.has(r.type));

        // ★ レイアウト順でソート（layoutに無いコードは末尾、同順はcodeで安定ソート）
        const orderIndex = new Map(layoutOrderCodes.map((c, i) => [c, i]));
        rows.sort((a, b) => {
            const ai = orderIndex.has(a.code) ? orderIndex.get(a.code) : Number.POSITIVE_INFINITY;
            const bi = orderIndex.has(b.code) ? orderIndex.get(b.code) : Number.POSITIVE_INFINITY;
            if (ai !== bi) return ai - bi;
            return a.code.localeCompare(b.code);
        });


        // render
        const el = root.querySelector('#view-fields');
        el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-weight:700">Field Inventory（読み取り専用）</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button id="fi-copy-md" class="btn">Copy Markdown</button>
          <button id="fi-dl-md"   class="btn">Download MD</button>
          <button id="fi-copy"    class="btn">Copy CSV</button>
          <button id="fi-json"    class="btn">Download JSON</button>
        </div>
      </div>
      <div id="kt-fields">
        <table>
          <thead><tr>
            <th>フィールド名</th><th>フィールドコード</th><th>必須</th>
            <th>初期値</th><th>フィールド形式</th><th>グループ</th>
          </tr></thead>
          <tbody id="fi-tbody"></tbody>
        </table>
      </div>
    `;
        const tbody = el.querySelector('#fi-tbody');
        rows.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
        <td>${escHTML(r.label)}</td>
        <td style="opacity:.9">${escHTML(r.code)}</td>
        <td>${r.required ? '✓' : ''}</td>
        <td style="opacity:.9">${escHTML(r.defaultValue)}</td>
        <td>${escHTML(r.type)}</td>
        <td style="opacity:.9">${escHTML(r.groupPath)}</td>
      `;
            tbody.appendChild(tr);
        });

        const md = toMarkdownWithNotes(rows);
        const csv = toCSV(rows);

        el.querySelector('#fi-copy').addEventListener('click', async () => {
            await navigator.clipboard.writeText(csv);
            const b = el.querySelector('#fi-copy'); const old = b.textContent; b.textContent = 'Copied!';
            setTimeout(() => b.textContent = old, 1200);
        }, { passive: true });
        el.querySelector('#fi-json').addEventListener('click', () => {
            download(`kintone_fields_${appId}.json`, JSON.stringify(rows, null, 2), 'application/json');
        }, { passive: true });
        el.querySelector('#fi-copy-md').addEventListener('click', async () => {
            await navigator.clipboard.writeText(md);
            const b = el.querySelector('#fi-copy-md'); const old = b.textContent; b.textContent = 'Copied!';
            setTimeout(() => b.textContent = old, 1200);
        }, { passive: true });
        el.querySelector('#fi-dl-md').addEventListener('click', () => {
            download(`kintone_fields_${appId}.md`, md, 'text/markdown');
        }, { passive: true });
    };

    /** ----------------------------
   * boot
   * ---------------------------- */
    waitReady().then(async () => {
        const appId = kintone.app.getId();
        if (!appId) return;

        const root = mountRoot();
        // render both views (independently)
        renderHealth(root, appId).catch(e => console.warn('[Toolkit] Health error', e));
        renderFields(root, appId).catch(e => console.warn('[Toolkit] Fields error', e));
    });

})();
