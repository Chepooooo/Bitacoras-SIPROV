// ==UserScript==
// @name         SIPROV - Recolector y confirmador de voluntarios
// @namespace    siprov.helper
// @version      2.8
// @description  Recolecta Carné, Identificación, Nombre, Correo, Carrera y Recinto (páginas de 19 filas) y confirma voluntarios "Sin Confirmar". Panel movible y minimizable.
// @match        https://siprov.ucr.ac.cr/*
// @updateURL    https://raw.githubusercontent.com/Chepoooo/Bitacoras-SIPROV/main/Bitacoras.users.js
// @downloadURL  https://raw.githubusercontent.com/Chepoooo/Bitacoras-SIPROV/main/Bitacoras.users.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  if (window.__siprovTM) return;
  window.__siprovTM = true;

  const KEY = "siprov_progreso";
  const COLS = ["Carné", "Identificación", "Nombre", "Correo", "Carrera", "Recinto"];
  const PAGE = 19;
  const NF = "No encontrado";
  let pageIdx = 0;
  let view = "datos";
  let busy = false;
  let stopFlag = false;
  let lastStatus = null;
  const confLines = [];
  let confSummary = "";
  let confHeadText = "Confirmación de voluntarios";

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(150);
    }
    throw new Error("Tiempo de espera agotado");
  };
  const waitForOrNull = async (fn, timeout = 4000) => {
    try { return await waitFor(fn, timeout); } catch (e) { return null; }
  };
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  // ---------- Selectores de SIPROV ----------
  const rowRe = /tabla_voluntarios_inscritos_grupo:\d+$/;
  const getRows = () => [...document.querySelectorAll("tr")].filter(tr => rowRe.test(tr.id));
  const links = tr => [...tr.querySelectorAll("a")];
  const nameLink = tr => {
    const byId = tr.querySelector('a[id$=":j_id144"]');
    if (byId) return byId;
    return links(tr).find(a => a.querySelector("span.iceOutTxt"));
  };
  const esListaEspera = tr => /lista\s*de\s*espera/i.test(tr.innerText);
  
  // Elementos del perfil
  const carneEl = () => document.querySelector('span[id$=":carne_ee"]');
  const correoEl = () => document.querySelector('span[id$=":correo_electronico_ee"]');
  const carreraEl = () => document.querySelector('span[id$=":carrera_ee"]');
  const recintoEl = () => document.querySelector('span[id$=":recinto_ee"]');
  const identificacionEl = () => document.querySelector('span[id$=":identificacion_ee"]');

  const inputBtn = cls => () => document.querySelector("input." + cls);
  const regresarBtn = inputBtn("opRegresar");
  const configurarBtn = inputBtn("opConfigurar");
  const confirmarBtn = inputBtn("opConfirmar");
  const guardarBtn = inputBtn("opGuardar");
  const cancelarBtn = inputBtn("opCancelar");

  const currentPage = () => {
    const m = [...document.body.innerText.matchAll(/Página (\d+) de (\d+)/g)].pop();
    return m ? { cur: +m[1], total: +m[2] } : { cur: 1, total: 1 };
  };
  const totalRegistros = () => {
    const m = [...document.body.innerText.matchAll(/(\d+) registros encontrados/g)].pop();
    return m ? +m[1] : "?";
  };
  const goToPage = async n => {
    if (currentPage().cur === n) return;
    const link = [...document.querySelectorAll("a")].find(a => a.textContent.trim() === String(n));
    if (!link) throw new Error("No encontré el enlace de la página " + n);
    link.click();
    await waitFor(() => currentPage().cur === n && getRows().length);
    await sleep(500);
  };

  // ---------- Datos y portapapeles ----------
  const load = () => {
    if (Array.isArray(window.__siprovData) && window.__siprovData.length) return window.__siprovData;
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(d) ? d.filter(r => r && typeof r === "object") : [];
    } catch (e) { return []; }
  };

  const buildHtml = (cols, rows) => {
    const th = cols.map(c => '<th style="border:1px solid #000;padding:4px 8px">' + esc(c) + "</th>").join("");
    const trs = rows.map(r => "<tr>" + cols.map(c =>
      '<td style="border:1px solid #000;padding:4px 8px">' + esc(r[c] == null ? "" : r[c]) + "</td>").join("") + "</tr>").join("");
    const head = cols.length > 1 ? "<thead><tr>" + th + "</tr></thead>" : "";
    return '<table style="border-collapse:collapse">' + head + "<tbody>" + trs + "</tbody></table>";
  };

  const copyToClipboard = async (plain, html) => {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([plain], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" })
          })
        ]);
        return true;
      }
      await navigator.clipboard.writeText(plain);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = plain; ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy"); ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  };

  // ---------- Botón flotante ----------
  const fab = document.createElement("button");
  fab.id = "siprov-fab";
  fab.textContent = "📋 SIPROV";
  fab.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483646;padding:8px 14px;" +
    "background:#1a73e8;color:#fff;border:none;border-radius:20px;cursor:pointer;" +
    "font:bold 13px sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4)";
  document.documentElement.appendChild(fab);

  // ---------- Ventana: barra de título + contenido ----------
  let shell = null;       // contenedor completo (barra + contenido)
  let panel = null;       // zona de contenido
  let keepAlive = null;
  let minimized = false;
  const pos = { top: 20, left: 20 };

  const updateBar = () => {
    if (!shell) return;
    const t = shell.querySelector("#sp-title");
    if (t) t.textContent = busy ? "⏳ SIPROV trabajando…" : "📋 SIPROV";
  };

  const applyMin = () => {
    if (!shell || !panel) return;
    panel.style.display = minimized ? "none" : "block";
    const mb = shell.querySelector("#sp-min");
    if (mb) {
      mb.textContent = minimized ? "▢" : "—";
      mb.title = minimized ? "Restaurar" : "Minimizar";
    }
    shell.style.borderRadius = minimized ? "8px" : "8px";
  };

  const redraw = () => {
    if (!panel) return;
    if (busy && lastStatus) paint(lastStatus.html, lastStatus.after);
    else if (view === "confirmar") renderConfirm();
    else render();
  };

  const openPanel = () => {
    if (shell && shell.isConnected) return;

    shell = document.createElement("div");
    shell.id = "siprov-shell";
    shell.style.cssText = "position:fixed;top:" + pos.top + "px;left:" + pos.left + "px;" +
      "z-index:2147483647;background:#fff;color:#000;border:2px solid #333;border-radius:8px;" +
      "font:13px sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:96vw";

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;" +
      "min-width:190px;padding:5px 8px;background:#1a73e8;color:#fff;cursor:move;" +
      "border-radius:5px 5px 0 0;user-select:none;touch-action:none";
    bar.innerHTML = '<b id="sp-title">📋 SIPROV</b>' +
      '<span><button id="sp-min" title="Minimizar" style="cursor:pointer;min-width:26px">—</button></span>';

    panel = document.createElement("div");
    panel.id = "siprov-panel";
    panel.style.cssText = "padding:10px;max-height:80vh;overflow:auto";

    shell.appendChild(bar);
    shell.appendChild(panel);
    document.documentElement.appendChild(shell);

    // Minimizar / restaurar
    bar.querySelector("#sp-min").onclick = () => { minimized = !minimized; applyMin(); };
    bar.addEventListener("dblclick", e => {
      if (e.target.closest("button")) return;
      minimized = !minimized;
      applyMin();
    });

    // Mover arrastrando la barra
    bar.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      const r = shell.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      try { bar.setPointerCapture(e.pointerId); } catch (err) {}
      const move = ev => {
        pos.left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 80);
        pos.top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 30);
        shell.style.left = pos.left + "px";
        shell.style.top = pos.top + "px";
      };
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });

    keepAlive = setInterval(() => {
      if (shell && !shell.isConnected) document.documentElement.appendChild(shell);
    }, 400);

    applyMin();
    updateBar();
    redraw();
  };

  const closePanel = () => {
    clearInterval(keepAlive);
    if (shell) shell.remove();
    shell = null;
    panel = null;
  };

  setInterval(() => {
    if (!fab.isConnected) document.documentElement.appendChild(fab);
  }, 800);

  fab.onclick = () => ((shell && shell.isConnected) ? closePanel() : openPanel());

  const paint = (html, after) => {
    if (!panel) return;
    panel.innerHTML = '<div style="min-width:280px">' + html + "</div>";
    updateBar();
    if (after) after();
  };
  const setStatus = (html, after) => {
    lastStatus = { html: html, after: after };
    paint(html, after);
  };

  const tabsHtml = () => {
    const b = (id, label) =>
      '<button data-tab="' + id + '" style="cursor:pointer;padding:4px 10px;' +
      (view === id ? "font-weight:bold;background:#cde;" : "") + '">' + label + "</button>";
    return '<div style="display:flex;gap:6px;margin-bottom:8px">' +
      b("datos", "Datos") + b("confirmar", "Confirmar voluntarios") + "</div>";
  };
  const bindTabs = () => {
    panel.querySelectorAll("button[data-tab]").forEach(b => {
      b.onclick = () => {
        if (busy) return;
        view = b.dataset.tab;
        redraw();
      };
    });
  };

  // =====================================================
  //  PESTAÑA 1: RECOLECCIÓN DE DATOS
  // =====================================================
  const scrape = async () => {
    try {
      await waitFor(() => getRows().length, 4000);
    } catch (e) {
      throw new Error("Abre primero el listado de inscritos (Detalle Grupo), en la página 1.");
    }
    const total = currentPage().total;
    const all = totalRegistros();
    const results = [];
    let omitidos = 0;
    let incompletos = 0;
    window.__siprovData = results;

    for (let p = 1; p <= total; p++) {
      await goToPage(p);
      const n = getRows().length;
      for (let i = 0; i < n; i++) {
        const tr = getRows()[i];

        if (esListaEspera(tr)) {
          omitidos++;
          setStatus("<b>Recolectando…</b> " + results.length + " de " + all +
            "<br><small>Omitido (Lista de Espera)</small><br><small>No toques la página.</small>");
          continue;
        }

        const link = nameLink(tr);
        const nombre = link.textContent.trim();
        link.click();

        const entroPerfil = await waitForOrNull(regresarBtn, 15000);
        if (!entroPerfil) {
          results.push({ "Carné": NF, "Identificación": NF, "Nombre": nombre, "Correo": NF, "Carrera": NF, "Recinto": NF });
          try { localStorage.setItem(KEY, JSON.stringify(results)); } catch (e) {}
          incompletos++;
          setStatus("<b>Recolectando…</b> " + results.length + " de " + all +
            "<br><small>" + esc(nombre) + " — no se pudo abrir el perfil</small>");
          continue;
        }

        await sleep(300);
        const carneNode = await waitForOrNull(carneEl, 4000);
        const correoNode = await waitForOrNull(correoEl, 4000);
        const carreraNode = await waitForOrNull(carreraEl, 4000);
        const recintoNode = await waitForOrNull(recintoEl, 4000);
        const idNode = await waitForOrNull(identificacionEl, 4000);

        const carne = (carneNode && carneNode.textContent.trim()) || NF;
        const correo = (correoNode && correoNode.textContent.trim()) || NF;
        const carrera = (carreraNode && carreraNode.textContent.trim()) || NF;
        const recinto = (recintoNode && recintoNode.textContent.trim()) || NF;
        const identificacion = (idNode && idNode.textContent.trim()) || NF;

        if (carne === NF || correo === NF || carrera === NF || recinto === NF || identificacion === NF) {
          incompletos++;
        }

        results.push({ 
          "Carné": carne, 
          "Identificación": identificacion, 
          "Nombre": nombre, 
          "Correo": correo, 
          "Carrera": carrera, 
          "Recinto": recinto 
        });
        
        try { localStorage.setItem(KEY, JSON.stringify(results)); } catch (e) {}
        
        setStatus("<b>Recolectando…</b> " + results.length + " de " + all +
          "<br><small>" + esc(nombre) + "</small><br><small>No toques la página.</small>");

        await waitFor(regresarBtn);
        regresarBtn().click();
        await waitFor(() => getRows().length && !carneEl());
        await sleep(600);
        await goToPage(p);
      }
    }
    window.__siprovOmitidos = omitidos;
    window.__siprovIncompletos = incompletos;
    return results;
  };

  const runScrape = async () => {
    pageIdx = 0;
    busy = true;
    setStatus("<b>Iniciando…</b>");
    try {
      await scrape();
      const om = window.__siprovOmitidos || 0;
      const inc = window.__siprovIncompletos || 0;
      let msg = "✔ Recolección terminada";
      if (om) msg += " · " + om + " en lista de espera, omitidos";
      if (inc) msg += " · " + inc + ' con datos faltantes (marcados "No encontrado")';
      busy = false; lastStatus = null;
      render(msg);
    } catch (e) {
      const parcial = load().length;
      busy = false; lastStatus = null;
      render("⚠ " + e.message + (parcial ? " (se conservaron " + parcial + " registros parciales)" : ""), true);
    }
  };

  function render(msg, isError) {
    msg = msg || "";
    if (!panel) return;
    updateBar();
    const data = load();
    const color = isError ? "#b00" : "#080";

    if (!data.length) {
      panel.innerHTML =
        '<div style="min-width:280px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:8px">' +
        '<b>Sin datos guardados</b><button id="sp-close" style="cursor:pointer">✕</button></div>' +
        tabsHtml() +
        '<button id="sp-run" style="cursor:pointer">Recolectar datos</button>' +
        '<div style="margin-top:6px;color:' + color + '">' + esc(msg) + "</div></div>";
      panel.querySelector("#sp-close").onclick = closePanel;
      panel.querySelector("#sp-run").onclick = runScrape;
      bindTabs();
      return;
    }

    const pages = Math.max(1, Math.ceil(data.length / PAGE));
    pageIdx = Math.min(Math.max(pageIdx, 0), pages - 1);
    const start = pageIdx * PAGE;
    const slice = data.slice(start, start + PAGE);

    const th = "border:1px solid #999;padding:4px 8px;background:#eee";
    const td = "border:1px solid #ccc;padding:3px 8px;";
    const tdCell = v => (v === NF
      ? '<td style="' + td + 'color:#b00;font-style:italic">' + esc(v) + "</td>"
      : '<td style="' + td + '">' + esc(v) + "</td>");

    let nav = "";
    if (pages > 1) {
      let nums = "";
      for (let i = 0; i < pages; i++) {
        nums += '<button data-page="' + i + '" style="cursor:pointer;' +
          (i === pageIdx ? "font-weight:bold;background:#cde;" : "") + '">' + (i + 1) + "</button>";
      }
      nav =
        '<div style="margin:0 0 8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<button id="sp-prev" style="cursor:pointer" ' + (pageIdx === 0 ? "disabled" : "") + ">‹ Anterior</button>" +
        nums +
        '<button id="sp-next" style="cursor:pointer" ' + (pageIdx === pages - 1 ? "disabled" : "") + ">Siguiente ›</button></div>" +
        '<div style="margin-bottom:6px"><b>Página ' + (pageIdx + 1) + " de " + pages + "</b> · filas " +
        (start + 1) + "–" + (start + slice.length) + " de " + data.length + "</div>";
    }

    const headCols = COLS.map(c =>
      '<th style="' + th + '">' + esc(c) + '<br><button data-col="' + esc(c) +
      '" style="cursor:pointer;margin-top:4px">Copiar</button></th>').join("");
    const bodyRows = slice.map((r, i) =>
      '<tr><td style="' + td + 'color:#777">' + (start + i + 1) + "</td>" +
      COLS.map(c => tdCell(r[c])).join("") + "<td></td></tr>").join("");

    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:12px">' +
      "<b>" + data.length + " registros</b><span>" +
      '<button id="sp-run" style="cursor:pointer">Recolectar de nuevo</button> ' +
      '<button id="sp-clear" style="cursor:pointer">Borrar datos</button> ' +
      '<button id="sp-close" style="cursor:pointer">✕</button></span></div>' +
      tabsHtml() + nav +
      '<table style="border-collapse:collapse"><thead><tr><th style="' + th + '">#</th>' + headCols +
      '<th style="' + th + '">Todo<br><button data-col="__all__" style="cursor:pointer;margin-top:4px">Copiar</button></th>' +
      "</tr></thead><tbody>" + bodyRows + "</tbody></table>" +
      '<div id="sp-msg" style="margin-top:6px;color:' + color + ';min-height:16px">' + esc(msg) + "</div>" +
      '<div style="margin-top:4px;font-size:11px;color:#666">Copiar copia solo las filas de esta página (máx. ' +
      PAGE + "), lista para pegar en Word, Docs o Excel.<br>En rojo: datos que no se encontraron en el perfil.</div>";

    panel.querySelector("#sp-close").onclick = closePanel;
    panel.querySelector("#sp-run").onclick = runScrape;
    panel.querySelector("#sp-clear").onclick = () => {
      if (confirm("¿Borrar los datos guardados?")) {
        localStorage.removeItem(KEY);
        window.__siprovData = [];
        pageIdx = 0;
        render("Datos borrados");
      }
    };
    bindTabs();
    const prev = panel.querySelector("#sp-prev");
    const next = panel.querySelector("#sp-next");
    if (prev) prev.onclick = () => { pageIdx--; render(); };
    if (next) next.onclick = () => { pageIdx++; render(); };
    panel.querySelectorAll("button[data-page]").forEach(b => {
      b.onclick = () => { pageIdx = +b.dataset.page; render(); };
    });

    panel.querySelectorAll("button[data-col]").forEach(b => {
      b.onclick = async () => {
        const col = b.dataset.col;
        const all = col === "__all__";
        const cols = all ? COLS : [col];
        const plain = all
          ? COLS.join("\t") + "\n" + slice.map(r => COLS.map(c => (r[c] == null ? "" : r[c])).join("\t")).join("\n")
          : slice.map(r => (r[col] == null ? "" : r[col])).join("\n");
        const html = buildHtml(cols, slice);
        const ok = await copyToClipboard(plain, html);
        const que = all ? "Tabla completa" : "Columna " + col;
        const donde = pages > 1 ? " · página " + (pageIdx + 1) + " de " + pages : "";
        const msgEl = panel ? panel.querySelector("#sp-msg") : null;
        if (msgEl) {
          msgEl.textContent = ok
            ? "✔ " + que + " copiada" + donde + " (" + slice.length + " filas)"
            : "No se pudo copiar";
        }
      };
    });
  }

  // =====================================================
  //  PESTAÑA 2: CONFIRMAR VOLUNTARIOS (modifica datos)
  // =====================================================
  const cfgLink = tr => links(tr).find(a => /configurar/i.test(a.textContent));
  const nombreDe = tr => {
    const a = links(tr).find(x => x.textContent.trim() && !/configurar|desinscribir/i.test(x.textContent));
    return a ? a.textContent.trim() : "";
  };
  const pendiente = tr => /sin\s*confirmar/i.test(tr.innerText.replace(/\s+/g, " "));

  const scanPendientes = async () => {
    const total = currentPage().total;
    const nombres = [];
    for (let p = 1; p <= total; p++) {
      await goToPage(p);
      getRows().filter(pendiente).forEach(tr => nombres.push(nombreDe(tr)));
    }
    await goToPage(1);
    return nombres;
  };

  const confirmarUno = async tr => {
    cfgLink(tr).click();
    await waitFor(configurarBtn);
    await sleep(400);
    configurarBtn().click();
    await waitFor(confirmarBtn);
    await sleep(300);
    confirmarBtn().click();
    await waitFor(() => !confirmarBtn() && guardarBtn());
    await sleep(300);
    guardarBtn().click();
    await waitFor(() => !guardarBtn());
    await sleep(600);
    await waitFor(regresarBtn);
    regresarBtn().click();
    await waitFor(() => getRows().length && !configurarBtn());
    await sleep(600);
  };

  const recover = async () => {
    try {
      if (cancelarBtn()) { cancelarBtn().click(); await sleep(800); }
      if (configurarBtn() && regresarBtn()) regresarBtn().click();
      await waitFor(() => getRows().length && !configurarBtn(), 15000);
    } catch (e) {
      throw new Error("No pude volver al listado tras un error. Revisa la pantalla manualmente.");
    }
  };

  const confDraw = head => {
    setStatus(
      "<b>" + esc(head) + "</b>" +
      '<div style="margin:6px 0"><button id="sc-stop" style="cursor:pointer">Detener</button></div>' +
      '<div style="font-family:monospace;font-size:11px">' + confLines.slice(-40).map(esc).join("<br>") + "</div>",
      () => {
        const s = panel ? panel.querySelector("#sc-stop") : null;
        if (s) s.onclick = () => { stopFlag = true; confLog("Deteniendo al terminar el actual…"); };
      }
    );
  };
  const confLog = t => { confLines.push(t); console.log("[SIPROV]", t); confDraw(confHeadText); };

  const runConfirm = async () => {
    confLines.length = 0;
    confSummary = "";
    stopFlag = false;
    busy = true;
    confHeadText = "Confirmación de voluntarios";
    const report = { confirmados: [], fallidos: [] };
    window.__siprovConfReport = report;

    try {
      try {
        await waitFor(() => getRows().length, 4000);
      } catch (e) {
        throw new Error("Abre primero el listado de inscritos (Detalle Grupo), en la página 1.");
      }

      confLog("Revisando estados…");
      const total = currentPage().total;
      const registros = totalRegistros();
      const pend = await scanPendientes();

      if (!pend.length) {
        busy = false; lastStatus = null;
        confSummary = "No hay voluntarios «Sin Confirmar». No se modificó nada.";
        return renderConfirm();
      }
      if (!confirm("Se encontraron " + pend.length + ' voluntarios "Sin Confirmar" de ' + registros +
                   " registros.\n\n¿Confirmar su participación?")) {
        busy = false; lastStatus = null;
        confSummary = "Cancelado. No se modificó nada.";
        return renderConfirm();
      }

      const tried = new Set();
      outer:
      for (let p = 1; p <= total; p++) {
        await goToPage(p);
        while (true) {
          if (stopFlag) { confLog("⏹ Detenido por el usuario."); break outer; }
          const tr = getRows().find(r => pendiente(r) && !tried.has(nombreDe(r)));
          if (!tr) break;
          const nombre = nombreDe(tr);
          tried.add(nombre);
          try {
            await confirmarUno(tr);
            await goToPage(p);
            const fila = getRows().find(r => nombreDe(r) === nombre);
            if (fila && /confirmado/i.test(fila.innerText) && !pendiente(fila)) {
              report.confirmados.push(nombre);
              confLog("✔ " + (report.confirmados.length + report.fallidos.length) + "/" + pend.length + " " + nombre);
            } else {
              report.fallidos.push(nombre + " (sigue Sin Confirmar, revisar)");
              confLog("⚠ " + nombre + ": no se ve como Confirmado");
            }
          } catch (e) {
            report.fallidos.push(nombre + " (" + e.message + ")");
            confLog("✖ " + nombre + ": " + e.message);
            await recover();
            await goToPage(p);
          }
        }
      }

      confSummary = "Terminado: " + report.confirmados.length + " confirmados, " +
        report.fallidos.length + " con problemas." +
        (report.fallidos.length ? "\nRevisar:\n" + report.fallidos.join("\n") : "");
    } catch (e) {
      confSummary = "⚠ " + e.message + "\nConfirmados hasta ahora: " + report.confirmados.length;
    }
    busy = false; lastStatus = null;
    renderConfirm();
  };

  function renderConfirm() {
    if (!panel) return;
    updateBar();
    const bad = /⚠|problemas: [1-9]/.test(confSummary);
    panel.innerHTML =
      '<div style="min-width:300px;max-width:380px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<b>Confirmar voluntarios</b><button id="sc-close" style="cursor:pointer">✕</button></div>' +
      tabsHtml() +
      '<div style="font-size:12px;margin-bottom:8px">Confirma la participación de quienes estén como ' +
      "<b>«Sin Confirmar»</b>. Omite a los «Confirmado» y a los de «Lista de Espera». Nunca usa [DesInscribir].<br>" +
      "Ve al listado de inscritos, en la <b>página 1</b>, antes de empezar.</div>" +
      '<button id="sc-run" style="cursor:pointer;padding:5px 12px">Buscar «Sin Confirmar» y confirmar</button>' +
      '<div style="margin-top:6px;font-size:11px;color:#666">Antes de modificar algo se te pedirá aceptar.</div>' +
      (confSummary
        ? '<div style="margin-top:8px;white-space:pre-line;color:' + (bad ? "#b00" : "#080") + '">' + esc(confSummary) + "</div>"
        : "") +
      (confLines.length
        ? '<details style="margin-top:6px"><summary>Registro</summary><div style="font-family:monospace;font-size:11px">' +
          confLines.map(esc).join("<br>") + "</div></details>"
        : "") +
      "</div>";
    panel.querySelector("#sc-close").onclick = closePanel;
    panel.querySelector("#sc-run").onclick = runConfirm;
    bindTabs();
  }
})();
//holamundo
