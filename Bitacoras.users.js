// ==UserScript==
// @name         SIPROV - Recolector y confirmador de voluntarios
// @namespace    siprov.helper
// @version      9.5
// @description  Recolecta datos, confirma voluntarios (lógica 2.6), busca personas y copia machotes.
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

  const COLS = ["Carné", "Nombre", "Identificación", "Correo", "Celular", "Carrera", "Recinto"];
  const PAGE = 19;
  const NF = "No encontrado";
  
  let groupedData = {}; 
  let pageIndexes = {}; 
  let selectedGroup = "";
  let showDetails = false;
  let stopFlag = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  
  const waitFor = async (fn, timeout = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(150); 
    }
    throw new Error(`Tiempo de espera agotado`);
  };
  const waitForOrNull = async (fn, timeout = 5000) => {
    try { return await waitFor(fn, timeout); } catch (e) { return null; }
  };
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  const normalizeText = str => String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const matchQuery = (text, query) => {
      const normText = normalizeText(text);
      const words = normalizeText(query).split(/\s+/).filter(w => w.length > 0);
      return words.every(w => normText.includes(w));
  };

  const forceClick = (el) => {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (el.click) el.click(); 
  };

  const style = document.createElement("style");
  style.innerHTML = `
    .siprov-menu-item {
      padding: 12px 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px; color: #333; cursor: pointer; border-bottom: 1px solid #f0f0f0;
      transition: background 0.2s, color 0.2s; display: flex; align-items: center; gap: 10px;
    }
    .siprov-menu-item:last-child { border-bottom: none; }
    .siprov-menu-item:hover { background: #e8f0fe; color: #1a73e8; }
    .siprov-menu-header {
      padding: 10px 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-weight: 600; background: #f8f9fa; border-bottom: 1px solid #ddd;
      font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .siprov-group-list {
      max-height: 200px; overflow-y: auto; border: 1px solid #ccc; border-radius: 6px;
      padding: 10px; background: #fff; display: flex; flex-wrap: wrap; gap: 10px;
    }
    .siprov-group-label {
      display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer;
      background: #f0f0f0; padding: 4px 10px; border-radius: 15px; border: 1px solid #ddd;
    }
    .siprov-group-label:hover { background: #e0e0e0; }
    .siprov-group-label input { cursor: pointer; }
  `;
  document.head.appendChild(style);

  // ---------- Selectores ----------
  const rowRe = /tabla_voluntarios_inscritos_grupo:\d+$/;
  const getRows = () => [...document.querySelectorAll("tr")].filter(tr => rowRe.test(tr.id));
  const links = tr => [...tr.querySelectorAll("a")];
  
  const nameLink = tr => {
    const byId = tr.querySelector('a[id$=":j_id144"]');
    if (byId) return byId;
    return links(tr).find(a => a.querySelector("span.iceOutTxt"));
  };
  
  const esListaEspera = tr => /lista\s*de\s*espera/i.test(tr.innerText);
  const pendiente = tr => /sin\s*confirmar/i.test(tr.innerText.replace(/\s+/g, " "));
  
  const cfgLink = tr => links(tr).find(a => /configurar/i.test(a.textContent));
  const nombreDe = tr => {
    const a = links(tr).find(x => x.textContent.trim() && !/configurar|desinscribir/i.test(x.textContent));
    return a ? a.textContent.trim() : "";
  };

  const carneEl = () => document.querySelector('span[id$=":carne_ee"]');
  const correoEl = () => document.querySelector('span[id$=":correo_electronico_ee"]');
  const carreraEl = () => document.querySelector('span[id$=":carrera_ee"]');
  const recintoEl = () => document.querySelector('span[id$=":recinto_ee"]');
  const identificacionEl = () => document.querySelector('span[id$=":identificacion_ee"]');
  const celularEl = () => document.querySelector('span[id$=":telefono_ee"]');

  const inputBtn = cls => () => document.querySelector("input." + cls);
  const regresarBtnPerfil = inputBtn("opRegresar"); 
  const btnRegresarGrupo = () => document.querySelector('input[name="sprv_form:btn_cancelar"]');

  const currentPage = () => {
    const m = [...document.body.innerText.matchAll(/Página (\d+) de (\d+)/g)].pop();
    return m ? { cur: +m[1], total: +m[2] } : { cur: 1, total: 1 };
  };
  
  const goToPage = async n => {
    if (currentPage().cur === n) return;
    const link = [...document.querySelectorAll("a")].find(a => a.textContent.trim() === String(n));
    if (!link) throw new Error("No encontré el enlace de la página " + n);
    forceClick(link);
    await waitFor(() => currentPage().cur === n && getRows().length);
    await sleep(300);
  };

  const copyToClipboard = async (plain, html) => {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([plain], { type: "text/plain" }),
            "text/html": new Blob([html || plain], { type: "text/html" })
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

  // ---------- UI: Botón y Menú Desplegable ----------
  const fab = document.createElement("button");
  fab.id = "siprov-fab";
  fab.innerHTML = "🛠️ Tools";
  const savedPos = JSON.parse(localStorage.getItem("siprov_fab_pos") || '{"bottom":"20px","right":"20px"}');
  fab.style.cssText = `position:fixed;z-index:2147483646;padding:10px 18px;background:#1a73e8;color:#fff;border:none;border-radius:25px;cursor:pointer;font:bold 14px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);touch-action:none;transition:transform 0.1s;`;
  Object.assign(fab.style, savedPos);
  document.documentElement.appendChild(fab);

  const menu = document.createElement("div");
  menu.id = "siprov-menu";
  menu.style.cssText = "position:fixed;z-index:2147483647;background:#fff;border:1px solid #ccc;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15);display:none;flex-direction:column;overflow:hidden;min-width:220px;";
  document.documentElement.appendChild(menu);

  const closeMenu = () => { menu.style.display = "none"; };

  const toggleMenu = () => {
    if (menu.style.display === "flex") { closeMenu(); return; }
    
    const rect = fab.getBoundingClientRect();
    menu.innerHTML = `
      <div class="siprov-menu-header">Herramientas SIPROV</div>
      <div id="m-confirmar" class="siprov-menu-item">1. Confirmar voluntarios</div>
      <div id="m-bitacoras" class="siprov-menu-item">2. Recolectar Datos</div>
      <div id="m-buscar" class="siprov-menu-item">3. Buscar persona</div>
      <div id="m-machotes" class="siprov-menu-item">4. Machotes Mensajes</div>
    `;
    
    if (rect.left > window.innerWidth / 2) menu.style.left = (rect.left - 220) + "px";
    else menu.style.left = rect.left + "px";
    
    if (rect.top > window.innerHeight / 2) menu.style.top = (rect.top - 180) + "px";
    else menu.style.top = (rect.bottom + 8) + "px";
    
    menu.style.display = "flex";

    menu.querySelector("#m-confirmar").onclick = () => { closeMenu(); openTaskWindow("confirmar"); };
    menu.querySelector("#m-bitacoras").onclick = () => { closeMenu(); openTaskWindow("bitacoras"); };
    menu.querySelector("#m-buscar").onclick = () => { closeMenu(); openTaskWindow("buscar"); };
    menu.querySelector("#m-machotes").onclick = () => { closeMenu(); openTaskWindow("machotes"); };
  };

  // Lógica arrastrar botón
  let isDraggingFab = false, dragStartX, dragStartY, startLeft, startTop;
  fab.addEventListener("pointerdown", e => {
    isDraggingFab = false; dragStartX = e.clientX; dragStartY = e.clientY;
    const rect = fab.getBoundingClientRect(); startLeft = rect.left; startTop = rect.top;
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener("pointermove", e => {
    if (e.buttons !== 1) return;
    const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) isDraggingFab = true;
    if (isDraggingFab) {
      fab.style.left = (startLeft + dx) + "px"; fab.style.top = (startTop + dy) + "px";
      fab.style.bottom = "auto"; fab.style.right = "auto";
    }
  });
  fab.addEventListener("pointerup", e => {
    if (isDraggingFab) {
      localStorage.setItem("siprov_fab_pos", JSON.stringify({ left: fab.style.left, top: fab.style.top }));
    } else {
      toggleMenu();
    }
  });

  // ---------- UI: Ventana de Tareas Flotante ----------
  let taskWindow = null;
  let panel = null;

  const closeTaskWindow = () => {
    if (taskWindow) taskWindow.remove();
    taskWindow = null;
    panel = null;
  };

  const openTaskWindow = async (viewType) => {
    closeTaskWindow();
    
    taskWindow = document.createElement("div");
    taskWindow.style.cssText = `position:fixed;top:50px;left:50px;z-index:2147483647;background:#fff;color:#000;border:1px solid #aaa;border-radius:8px;font:13px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3);width:650px;height:600px;display:flex;flex-direction:column;resize:both;overflow:hidden;`;

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:10px 15px;background:#1a73e8;color:#fff;border-radius:7px 7px 0 0;user-select:none;cursor:move;flex-shrink:0;";
    bar.innerHTML = `<b style="font-size:14px;">Herramientas SIPROV</b><button id="tw-close" style="background:none;border:none;color:#fff;cursor:pointer;font-size:18px;font-weight:bold;">✕</button>`;
    
    panel = document.createElement("div");
    panel.style.cssText = "padding:15px;overflow:auto;flex:1;display:flex;flex-direction:column;background:#fcfcfc;";

    taskWindow.appendChild(bar);
    taskWindow.appendChild(panel);
    document.documentElement.appendChild(taskWindow);

    bar.querySelector("#tw-close").onclick = closeTaskWindow;

    // Arrastrar ventana
    let isDragging = false, mStartLeft, mStartTop, mDragStartX, mDragStartY;
    bar.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      isDragging = false; mDragStartX = e.clientX; mDragStartY = e.clientY;
      const r = taskWindow.getBoundingClientRect(); mStartLeft = r.left; mStartTop = r.top;
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener("pointermove", e => {
      if (e.buttons !== 1) return;
      const dx = e.clientX - mDragStartX, dy = e.clientY - mDragStartY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) isDragging = true;
      if (isDragging) {
        taskWindow.style.left = (mStartLeft + dx) + "px"; taskWindow.style.top = (mStartTop + dy) + "px";
        taskWindow.style.right = "auto"; taskWindow.style.bottom = "auto";
      }
    });

    const updateStatus = (msg, isError) => {
      const el = panel.querySelector("#tw-status");
      if (el) { el.innerHTML = msg; el.style.color = isError ? "#d32f2f" : "#2e7d32"; }
    };

    const setupButtons = (startBtnId, stopBtnId, startCb, stopCb) => {
        const startBtn = panel.querySelector(`#${startBtnId}`);
        const stopBtn = panel.querySelector(`#${stopBtnId}`);
        if(!startBtn || !stopBtn) return;

        startBtn.onclick = () => {
            startBtn.style.display = "none";
            stopBtn.style.display = "inline-block";
            stopBtn.disabled = false;
            stopBtn.textContent = "⏹ Detener";
            stopBtn.style.background = "#d32f2f";
            stopFlag = false;
            startCb();
        };

        stopBtn.onclick = () => {
            stopFlag = true;
            stopBtn.disabled = true;
            stopBtn.textContent = "Deteniendo...";
            if(stopCb) stopCb();
        };
    };

    const showProcessFinished = (startBtnId, stopBtnId) => {
        const startBtn = panel.querySelector(`#${startBtnId}`);
        const stopBtn = panel.querySelector(`#${stopBtnId}`);
        if(startBtn && stopBtn) {
            startBtn.style.display = "inline-block";
            stopBtn.style.display = "none";
        }
    };

    if (viewType === "bitacoras") {
      panel.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;height:100%;">
          <div style="font-weight:bold;font-size:16px;color:#333;">Recolectar Datos por Grupo</div>
          
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="font-size:13px;color:#666;">Selecciona los grupos detectados (Máx. 15, ordenados de mayor a menor):</div>
            <button id="tw-refresh-groups" style="background:none;border:none;color:#1a73e8;cursor:pointer;font-size:12px;text-decoration:underline;">Refrescar lista</button>
          </div>
          
          <div id="tw-groups-container" style="min-height:60px; display:flex; align-items: center; justify-content: center; background:#f0f0f0; border-radius:6px; padding:15px;">
            <span style="color:#888;">Escaneando grupos...</span>
          </div>

          <div style="display:flex; gap:10px; margin-top:5px;">
            <button id="tw-run-bitacora" style="flex:1;padding:12px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;transition:background 0.2s;">Iniciar Recolección</button>
            <button id="tw-stop-bitacora" style="display:none;flex:1;padding:12px;background:#d32f2f;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">⏹ Detener</button>
          </div>
          
          <div id="tw-status" style="font-size:13px;font-weight:500;margin-top:10px;"></div>
        </div>
      `;

      const container = panel.querySelector("#tw-groups-container");
      
      const loadGroups = async () => {
        container.innerHTML = `<span style="color:#888;">Buscando grupos...</span>`;
        
        let groupsArray = [];
        
        try {
            const editBtns = [...document.querySelectorAll('a, input')].filter(el => (el.textContent && el.textContent.trim().toLowerCase() === 'editar') || (el.value && el.value.trim().toLowerCase() === 'editar'));
            
            editBtns.forEach((btn, idx) => {
                let card = btn.closest('.icePnGpr') || btn.closest('.formularioClaro') || btn.parentElement.parentElement;
                if (card) {
                    const txt = card.textContent;
                    const match = txt.match(/Grupo\s*(\d+)/i);
                    if (match && match[1]) {
                        const num = String(match[1]).trim();
                        if (num !== "" && !isNaN(Number(num))) {
                            if (!groupsArray.includes(num)) {
                                groupsArray.push(num);
                            }
                        }
                    }
                }
            });

            if (groupsArray.length === 0) {
                const html = document.body.innerHTML;
                const matches = html.matchAll(/Grupo\s*(\d+)/gi);
                for (const m of matches) {
                    if (m[1]) {
                        const num = String(m[1]).trim();
                        if (num !== "" && !isNaN(Number(num))) {
                            if (!groupsArray.includes(num)) {
                                groupsArray.push(num);
                            }
                        }
                    }
                }
            }

        } catch (e) {}

        groupsArray.sort((a,b) => Number(b) - Number(a));
        const limitedGroups = groupsArray.slice(0, 15);

        if (limitedGroups.length === 0) {
           container.innerHTML = `<span style="color:#d32f2f;">No se detectaron grupos.</span>`;
        } else {
           container.innerHTML = `<div class="siprov-group-list" style="width:100%;">
             ${limitedGroups.map(g => `
               <label class="siprov-group-label">
                 <input type="checkbox" class="tw-chk-group" value="${g}"> Grupo ${g}
               </label>
             `).join('')}
           </div>`;
        }
      };

      loadGroups();
      panel.querySelector("#tw-refresh-groups").onclick = loadGroups;

      setupButtons("tw-run-bitacora", "tw-stop-bitacora", () => {
        const checked = [...panel.querySelectorAll(".tw-chk-group:checked")].map(chk => chk.value);
        
        if (checked.length === 0) {
           updateStatus("Debes seleccionar al menos un grupo.", true);
           showProcessFinished("tw-run-bitacora", "tw-stop-bitacora");
           return;
        }

        panel.querySelectorAll(".tw-chk-group").forEach(chk => chk.disabled = true);
        panel.querySelector("#tw-refresh-groups").disabled = true;
        panel.querySelector("#tw-refresh-groups").style.opacity = "0.5";

        startScraping(checked, updateStatus).then(() => {
            showProcessFinished("tw-run-bitacora", "tw-stop-bitacora");
        });
      });
    } 
    else if (viewType === "confirmar") {
      panel.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;height:100%;">
          <div style="font-weight:bold;font-size:16px;color:#333;">Confirmar Voluntarios</div>
          <div style="font-size:13px;color:#666;">Busca y confirma a los voluntarios "Sin Confirmar" en el grupo actual.</div>
          
          <div style="display:flex; gap:10px;">
            <button id="tw-run-confirm" style="flex:1;padding:12px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;transition:background 0.2s;">Buscar «Sin Confirmar» y confirmar</button>
            <button id="tw-stop-confirm" style="display:none;flex:1;padding:12px;background:#d32f2f;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">⏹ Detener</button>
          </div>
          
          <div id="tw-status" style="font-size:13px;font-weight:500;margin-top:10px;"></div>
        </div>
      `;
      
      setupButtons("tw-run-confirm", "tw-stop-confirm", () => {
          runConfirmProcess(updateStatus).then(() => {
              showProcessFinished("tw-run-confirm", "tw-stop-confirm");
          });
      });
    }
    else if (viewType === "buscar") {
      panel.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;height:100%;">
          <div style="font-weight:bold;font-size:16px;color:#333;">Buscar Persona</div>
          <div style="font-size:13px;color:#666;">Ingresa un nombre o apellido para buscarlo.</div>
          <input id="tw-inp-search" type="text" placeholder="Nombre o apellido..." style="padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;outline:none;">
          
          <div style="display:flex; gap:10px;">
            <button id="tw-run-search" style="flex:1;padding:12px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">Buscar</button>
            <button id="tw-stop-search" style="display:none;flex:1;padding:12px;background:#d32f2f;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">⏹ Detener</button>
          </div>
          
          <div id="tw-status" style="font-size:13px;font-weight:500;"></div>
          <div id="tw-search-results" style="margin-top:10px;font-size:13px;overflow:auto;"></div>
        </div>
      `;
      
      setupButtons("tw-run-search", "tw-stop-search", () => {
          runSearchProcess(updateStatus).then(() => {
              showProcessFinished("tw-run-search", "tw-stop-search");
          });
      });
    }
    else if (viewType === "machotes") {
      panel.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;height:100%;">
          <div style="font-weight:bold;font-size:16px;color:#333;">Machotes Mensajes</div>
          <div style="font-size:13px;color:#666;margin-bottom:10px;">Selecciona el mensaje que deseas copiar al portapapeles.</div>
          
          <div style="display:flex; flex-direction:column; gap:15px;">
              <div>
                  <div style="font-size:13px;font-weight:bold;color:#555;margin-bottom:5px;">1. Link de WhatsApp</div>
                  <input id="tw-inp-link" type="text" placeholder="Pega el link aquí..." style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;outline:none;margin-bottom:8px;">
                  <button id="tw-copy-msg1" style="width:100%;padding:10px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Copiar Mensaje con Link</button>
              </div>
              
              <hr style="border:none;border-top:1px solid #ddd;margin:5px 0;">
              
              <div>
                  <div style="font-size:13px;font-weight:bold;color:#555;margin-bottom:5px;">2. Mensaje de Instrucciones</div>
                  <button id="tw-copy-msg2" style="width:100%;padding:10px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Copiar Texto de Instrucciones</button>
              </div>
              
              <hr style="border:none;border-top:1px solid #ddd;margin:5px 0;">
              
              <div>
                  <div style="font-size:13px;font-weight:bold;color:#555;margin-bottom:5px;">3. Mensaje de Cierre</div>
                  <button id="tw-copy-msg3" style="width:100%;padding:10px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Copiar Mensaje de Cierre</button>
              </div>
          </div>

          <div id="tw-status" style="font-size:13px;font-weight:500;margin-top:15px;text-align:center;"></div>
        </div>
      `;

      panel.querySelector("#tw-copy-msg1").onclick = async () => {
          const link = panel.querySelector("#tw-inp-link").value.trim();
          if (!link) {
              updateStatus("Por favor, ingresa un link primero.", true);
              return;
          }
          const msg1 = `Saludos cordiales, espero que se encuentre muy bien!\n\nLe saluda , asistente del Programa de Voluntariado de la UCR.🌱💙\n\nLe comparto el link del grupo de WA del proyecto en el que usted se inscribió. Por favor unirse para coordinar.\n\n${link}\n\nCualquier consulta con todo gusto. 🙌🏻`;
          const ok = await copyToClipboard(msg1, msg1.replace(/\n/g, '<br>'));
          updateStatus(ok ? "✔ Mensaje 1 copiado con éxito." : "Error al copiar.", !ok);
      };

      panel.querySelector("#tw-copy-msg2").onclick = async () => {
          const msg2 = `Saludos cordiales✨ \n\nDesde el Programa de Voluntariado queremos agradecerles el interés por participar en este proyecto sentimos mucha emoción por hacer lo que más nos gusta, *dejar huella*🌱 \n\nPara este proyecto es importante tener en cuenta los siguientes puntos: \n\n✅Llevar botella de agua llena\n✅El uso de la camisa de voluntariado es obligatorio. \n❗Si alguna de las personas inscritas no tiene camisa, puede retirarla entre semana de 8am a 4pm en la oficina del Programa de Voluntariado (https://maps.app.goo.gl/D7LvRuurZ258wgrx5) antes del proyecto, o en su defecto, indicar su talla para enviarla con la persona asistente.\n\n📌El lugar de encuentro es \n✅ Favor ser puntuales, el horario es\n\n¡Gracias por sumarse! ✨ \nEstamos en contacto, cualquier consulta por este medio.`;
          const ok = await copyToClipboard(msg2, msg2.replace(/\n/g, '<br>'));
          updateStatus(ok ? "✔ Mensaje 2 copiado con éxito." : "Error al copiar.", !ok);
      };

      panel.querySelector("#tw-copy-msg3").onclick = async () => {
          const msg3 = `Saludos cordiales, los grupos de WhatsApp para proyectos de voluntariado se abren con la finalidad de facilitar la comunicación durante la ejecución del proyecto. Cumplido este objetivo, no queda nada más que *agradecerles su participación e invitarles a que sigan disfrutando de Voluntariado UCR*✨💙`;
          const ok = await copyToClipboard(msg3, msg3.replace(/\n/g, '<br>'));
          updateStatus(ok ? "✔ Mensaje 3 copiado con éxito." : "Error al copiar.", !ok);
      };
    }
    else if (viewType === "tabla") {
      renderTables(updateStatus);
    }
  };

  // ---------- Lógica: Confirmar Voluntarios (LÓGICA V2.6 RESTAURADA) ----------
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
    const btnConfig = [...tr.querySelectorAll("a, input")].find(el => (el.textContent && el.textContent.toLowerCase().includes("configurar")) || (el.value && el.value.toLowerCase().includes("configurar")));
    if (!btnConfig) throw new Error("No se encontró 'Configurar' en la fila.");

    forceClick(btnConfig);
    await waitFor(() => document.querySelector("input.opConfigurar") || document.querySelector("input.opRegresar"), 20000);
    await sleep(400);

    const configurarBtn = document.querySelector("input.opConfigurar");
    if (configurarBtn) {
        forceClick(configurarBtn);
        await waitFor(() => document.querySelector("input.opConfirmar") || document.querySelector("input.opGuardar"), 20000);
        await sleep(300);
    }

    const confirmarBtn = document.querySelector("input.opConfirmar");
    if (confirmarBtn) {
        forceClick(confirmarBtn);
        await waitFor(() => !document.querySelector("input.opConfirmar") && document.querySelector("input.opGuardar"), 20000);
        await sleep(300);
    }

    const guardarBtn = document.querySelector("input.opGuardar");
    if (!guardarBtn) throw new Error("No se encontró 'Guardar'.");
    forceClick(guardarBtn);

    await waitFor(() => !document.querySelector("input.opGuardar"), 20000);
    await sleep(600);

    const regresarBtn = document.querySelector("input.opRegresar");
    if (regresarBtn) {
        forceClick(regresarBtn);
        await waitFor(() => getRows().length && !document.querySelector("input.opConfigurar"), 20000);
        await sleep(600);
    }
  };

  const recover = async () => {
    try {
      const btnCancelar = document.querySelector("input.opCancelar");
      if (btnCancelar) { forceClick(btnCancelar); await sleep(800); }
      const btnConfig = document.querySelector("input.opConfigurar");
      const btnReg = document.querySelector("input.opRegresar");
      if (btnConfig && btnReg) { forceClick(btnReg); }
      await waitFor(() => getRows().length && !document.querySelector("input.opConfigurar"), 15000);
    } catch (e) {
      throw new Error("No pude volver al listado tras un error. Revisa la pantalla manualmente.");
    }
  };

  const runConfirmProcess = async (updateStatus) => {
    updateStatus("Revisando estados en todas las páginas...");
    
    try {
      const total = currentPage().total;
      const pend = await scanPendientes();

      if (!pend.length) {
        updateStatus("No hay voluntarios «Sin Confirmar». No se modificó nada.");
        return;
      }
      if (!confirm(`Se encontraron ${pend.length} voluntarios "Sin Confirmar" en total.\n\n¿Confirmar su participación?`)) {
        updateStatus("Cancelado. No se modificó nada.");
        return;
      }

      const tried = new Set();
      let count = 0;

      outer:
      for (let p = 1; p <= total; p++) {
        await goToPage(p);
        while (true) {
          if (stopFlag) { break outer; }
          
          const tr = getRows().find(r => pendiente(r) && !tried.has(nombreDe(r)));
          if (!tr) break;
          
          const nombre = nombreDe(tr);
          tried.add(nombre);
          updateStatus(`Confirmando: ${nombre}... (${count}/${pend.length})`);
          
          try {
            await confirmarUno(tr);
            await goToPage(p);
            const fila = getRows().find(r => nombreDe(r) === nombre);
            if (fila && /confirmado/i.test(fila.innerText) && !pendiente(fila)) {
              count++;
            } else {
               updateStatus(`⚠ ${nombre} no se ve como confirmado.`);
            }
          } catch (e) {
            updateStatus(`❌ Error con ${nombre}`);
            await recover();
            await goToPage(p);
          }
        }
      }
      updateStatus(`✔ Proceso terminado: ${count} confirmados.`);
    } catch (e) {
      updateStatus("⚠ " + e.message, true);
    }
  };

  // ---------- Lógica: Buscar Persona ----------
  const runSearchProcess = async (updateStatus) => {
    const query = panel.querySelector("#tw-inp-search").value.trim();
    if (!query) {
        updateStatus("Escribe un nombre para buscar.", true);
        return;
    }

    updateStatus("Buscando...");
    const resDiv = panel.querySelector("#tw-search-results");
    resDiv.innerHTML = "Iniciando búsqueda...";

    try {
      let groupsArray = [];
      const editBtns = [...document.querySelectorAll('a, input')].filter(el => (el.textContent && el.textContent.trim().toLowerCase() === 'editar') || (el.value && el.value.trim().toLowerCase() === 'editar'));
      
      editBtns.forEach(btn => {
          let card = btn.closest('.icePnGpr') || btn.closest('.formularioClaro') || btn.parentElement.parentElement;
          if (card) {
              const match = card.textContent.match(/Grupo\s*(\d+)/i);
              if (match && match[1]) {
                  const num = String(match[1]).trim();
                  if (num !== "" && !isNaN(Number(num))) {
                      if (!groupsArray.includes(num)) groupsArray.push(num);
                  }
              }
          }
      });

      groupsArray.sort((a,b) => Number(b) - Number(a));

      const matches = [];
      
      for (let g of groupsArray) {
        if (stopFlag) { break; }
        
        updateStatus(`Revisando Grupo ${g}...`);
        
        const card = await findGroupCard(g);
        if (!card) {
            continue;
        }
        
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(400);

        const btnEditar = [...card.querySelectorAll("a, input")].find(el => (el.textContent && el.textContent.trim().toLowerCase() === "editar") || (el.value && el.value.trim().toLowerCase() === "editar"));
        if (!btnEditar) {
            continue;
        }

        forceClick(btnEditar);
        
        try {
            await waitFor(() => document.querySelector('table[id^="tabla_voluntarios"]') || document.querySelector('input.opRegresar'), 15000);
        } catch(e) {
            const btnBack = btnRegresarGrupo();
            if (btnBack) forceClick(btnBack);
            await sleep(1000);
            continue;
        }

        const totalPaginas = currentPage().total;
        
        for (let p = 1; p <= totalPaginas; p++) {
            if (stopFlag) break;
            
            if (p > 1) {
                try {
                    await goToPage(p);
                } catch (e) {
                    break; 
                }
            }

            const rows = getRows();
            for (let tr of rows) {
                if (esListaEspera(tr)) continue;
                const link = nameLink(tr);
                if (!link) continue;
                
                const nombre = link.textContent.trim();
                
                if (matchQuery(nombre, query)) {
                    forceClick(link);
                    const entroPerfil = await waitForOrNull(regresarBtnPerfil, 15000);
                    if (entroPerfil) {
                        await sleep(300);
                        const carne = (carneEl() && carneEl().textContent.trim()) || "-";
                        const tel = (celularEl() && celularEl().textContent.trim()) || "-";
                        
                        let existing = matches.find(m => m.carne === carne && carne !== "-");
                        if (existing) {
                            if (!existing.grupo.split(', ').includes(g)) {
                                existing.grupo += `, ${g}`;
                            }
                        } else {
                            matches.push({ nombre, carne, tel, grupo: g });
                        }
                        
                        forceClick(regresarBtnPerfil());
                        await waitFor(() => getRows().length > 0, 15000);
                        await sleep(400);
                        
                        if (p > 1) {
                            try {
                                await goToPage(p);
                            } catch(e) {}
                        }
                    }
                }
            }
        }

        const btnBack = btnRegresarGrupo();
        if (btnBack) { 
            forceClick(btnBack); 
            try {
                await waitFor(() => [...document.querySelectorAll('a, input')].some(el => (el.textContent && el.textContent.trim().toLowerCase() === 'editar') || (el.value && el.value.trim().toLowerCase() === 'editar')), 10000);
            } catch (e) {}
            await sleep(500); 
        }
      }

      if (matches.length > 0) {
        let html = `<table style="width:100%; border-collapse: collapse;">
            <thead><tr style="background:#f8f9fa; color:#333;">
                <th style="border:1px solid #ccc;padding:6px;text-align:left;">Nombre</th>
                <th style="border:1px solid #ccc;padding:6px;text-align:left;">Carné</th>
                <th style="border:1px solid #ccc;padding:6px;text-align:left;">Teléfono</th>
                <th style="border:1px solid #ccc;padding:6px;text-align:left;">Grupo(s)</th>
            </tr></thead>
            <tbody>`;
        matches.forEach(m => {
            html += `<tr>
                <td style="border:1px solid #ccc;padding:6px;">${esc(m.nombre)}</td>
                <td style="border:1px solid #ccc;padding:6px;">${esc(m.carne)}</td>
                <td style="border:1px solid #ccc;padding:6px;">${esc(m.tel)}</td>
                <td style="border:1px solid #ccc;padding:6px;">${esc(m.grupo)}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
        resDiv.innerHTML = html;
        updateStatus("Búsqueda finalizada.");
      } else {
        resDiv.innerHTML = "No se encontró a nadie.";
        updateStatus("Búsqueda finalizada.");
      }

    } catch (e) {
      updateStatus("⚠ Error: " + e.message, true);
      const btnBack = btnRegresarGrupo();
      if (btnBack) { forceClick(btnBack); await sleep(2000); }
    }
  };

  // ---------- Lógica: Encontrar Tarjeta de Grupo ----------
  const findGroupCard = async (g) => {
    const regex = new RegExp('^\\s*Grupo\\s*' + g + '\\s*$', 'i');
    
    const checkAllElements = () => {
        const all = document.querySelectorAll('span, div, td, b, strong, a');
        for (let el of all) {
            if (regex.test(el.textContent)) return el;
        }
        return null;
    };

    let targetEl = checkAllElements();
    if (targetEl) return getCard(targetEl);

    window.scrollTo(0, 0);
    await sleep(500);

    let scrollY = 0;
    const scrollHeight = document.body.scrollHeight;
    
    while (scrollY < scrollHeight && !stopFlag) {
        scrollY += 800;
        window.scrollTo(0, scrollY);
        await sleep(300);
        
        targetEl = checkAllElements();
        if (targetEl) {
            window.scrollTo(0, 0);
            return getCard(targetEl);
        }
    }

    window.scrollTo(0, 0);
    return null;
  };

  const getCard = (el) => {
    let card = el;
    while (card && card !== document.body) {
        if (card.querySelector('a, input') && card.innerText.includes("Editar")) {
            return card;
        }
        card = card.parentElement;
    }
    return null;
  };

  // ---------- Lógica: Scraping Profundo ----------
  const startScraping = async (grupos, updateStatus) => {
    groupedData = {};
    pageIndexes = {};
    grupos.forEach(g => { groupedData[g] = []; pageIndexes[g] = 0; });

    updateStatus("<b>Iniciando...</b>");
    
    for (let g of grupos) {
      if (stopFlag) { break; }
      
      try {
        updateStatus(`<b>Buscando grupo ${g}...</b>`);
        
        const card = await findGroupCard(g);
        
        if (!card) {
          groupedData[g] = [{ Carné: "ERROR", Nombre: `Grupo ${g} no encontrado`, Correo: "-", Identificación: "-", Celular: "-", Carrera: "-", Recinto: "-" }];
          continue; 
        }
        
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(800);

        const btnEditar = [...card.querySelectorAll("a, input")].find(el => (el.textContent && el.textContent.trim().toLowerCase() === "editar") || (el.value && el.value.trim().toLowerCase() === "editar"));
        if (!btnEditar) {
           groupedData[g] = [{ Carné: "ERROR", Nombre: `Botón editar no encontrado en ${g}`, Correo: "-", Identificación: "-", Celular: "-", Carrera: "-", Recinto: "-" }];
           continue;
        }

        forceClick(btnEditar);
        
        try {
            await waitFor(() => document.querySelector('input.opRegresar') || document.querySelector('table[id^="tabla_voluntarios"]'), 20000);
        } catch (e) {
            groupedData[g] = [{ Carné: "ERROR", Nombre: `No cargó el grupo ${g} (Tiempo agotado)`, Correo: "-", Identificación: "-", Celular: "-", Carrera: "-", Recinto: "-" }];
            
            const btnBack = btnRegresarGrupo();
            if (btnBack) forceClick(btnBack);
            await sleep(2000);
            continue;
        }
        await sleep(1000);

        const totalPaginas = currentPage().total;
        
        for (let p = 1; p <= totalPaginas; p++) {
          if (stopFlag) break;
          
          await goToPage(p);
          const n = getRows().length;
          
          for (let i = 0; i < n; i++) {
            if (stopFlag) break;
            
            const tr = getRows()[i];
            if (esListaEspera(tr)) continue;

            const link = nameLink(tr);
            if (!link) continue; 
            
            const nombre = link.textContent.trim();
            updateStatus(`<b>Grupo ${g} (Pág ${p}/${totalPaginas})</b><br>Extrayendo: ${nombre}`);
            
            forceClick(link);
            const entroPerfil = await waitForOrNull(regresarBtnPerfil, 20000);
            if (!entroPerfil) {
              groupedData[g].push({ Carné: NF, Nombre: nombre, Correo: NF, Identificación: NF, Celular: NF, Carrera: NF, Recinto: NF });
              continue;
            }

            await sleep(400);
            const carneNode = await waitForOrNull(carneEl, 5000);
            const correoNode = await waitForOrNull(correoEl, 5000);
            const carreraNode = await waitForOrNull(carreraEl, 5000);
            const recintoNode = await waitForOrNull(recintoEl, 5000);
            const idNode = await waitForOrNull(identificacionEl, 5000);
            const celularNode = await waitForOrNull(celularEl, 5000);

            groupedData[g].push({
              Carné: (carneNode && carneNode.textContent.trim()) || NF,
              Nombre: nombre,
              Identificación: (idNode && idNode.textContent.trim()) || NF,
              Correo: (correoNode && correoNode.textContent.trim()) || NF,
              Celular: (celularNode && celularNode.textContent.trim()) || NF,
              Carrera: (carreraNode && carreraNode.textContent.trim()) || NF,
              Recinto: (recintoNode && recintoNode.textContent.trim()) || NF
            });

            await waitFor(regresarBtnPerfil);
            forceClick(regresarBtnPerfil());
            await waitFor(() => getRows().length && !carneEl());
            await sleep(600);
            await goToPage(p); 
          }
        }
        
        updateStatus(`<b>Terminado grupo ${g}. Volviendo...</b>`);
        
        const btnBack = btnRegresarGrupo();
        if (btnBack) {
            forceClick(btnBack);
            await sleep(1500);
            window.scrollTo(0, 0);
        }
      } catch (err) {
        groupedData[g] = [{ Carné: "ERROR", Nombre: `Error: ${err.message}`, Correo: "-", Identificación: "-", Celular: "-", Carrera: "-", Recinto: "-" }];
        const btnBack = btnRegresarGrupo();
        if (btnBack) { forceClick(btnBack); await sleep(2000); }
      }
    }

    selectedGroup = Object.keys(groupedData).find(k => groupedData[k].length > 0) || "";
    
    panel.innerHTML = `<div style="display:flex; flex-direction: column; height:100%;" id="tw-tabla-container"></div>`;
    renderTables(updateStatus);
  };

  // ---------- Renderizar Tablas (Navegación por Grupo) ----------
  const renderTables = (updateStatus) => {
    const container = panel.querySelector("#tw-tabla-container") || panel;
    
    const groups = Object.keys(groupedData).sort((a,b) => Number(b) - Number(a));
    
    if (groups.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:#666;margin-top:20px;">No hay datos para mostrar.</div>`;
      return;
    }
    if (!selectedGroup || !groupedData[selectedGroup]) {
      selectedGroup = groups[0];
    }

    let selectHtml = `<select id="tw-group-select" style="padding:8px;font-size:14px;border-radius:6px;border:1px solid #ccc;background:#fff;outline:none;min-width:200px;">`;
    groups.forEach(g => {
      const count = groupedData[g].length;
      const label = (count === 1 && groupedData[g][0].Carné === "ERROR") ? `Grupo ${g} (Error)` : `Grupo ${g} (${count} voluntarios)`;
      selectHtml += `<option value="${g}" ${g === selectedGroup ? 'selected' : ''}>${label}</option>`;
    });
    selectHtml += `</select>`;

    const data = groupedData[selectedGroup];
    const isErrorGroup = data.length === 1 && data[0].Carné === "ERROR";

    let contentHtml = ``;
    if (!isErrorGroup) {
      const totalPages = Math.ceil(data.length / PAGE);
      const currPage = pageIndexes[selectedGroup] || 0;
      const start = currPage * PAGE;
      const slice = data.slice(start, start + PAGE);

      const th = "border-bottom:2px solid #ddd;border-top:1px solid #ddd;padding:10px;background:#f8f9fa;text-align:center;font-size:12px;color:#444;font-weight:bold;white-space:nowrap";
      const td = "border-bottom:1px solid #eee;padding:8px 10px;vertical-align:top;font-size:13px;";
      const isDet = c => c !== "Carné" && c !== "Nombre";

      if (totalPages > 1) {
        contentHtml += `<div style="margin-bottom:12px;display:flex;gap:6px;flex-wrap:wrap;">`;
        for (let i = 0; i < totalPages; i++) {
          contentHtml += `<button data-page="${i}" style="cursor:pointer;font-size:11px;padding:4px 10px;border:1px solid #ccc;border-radius:4px;background:#fff;${i === currPage ? "font-weight:bold;background:#1a73e8;color:#fff;border-color:#1a73e8;" : ""}">${i + 1}</button>`;
        }
        contentHtml += `</div>`;
      }

      contentHtml += `<div style="overflow:auto;border:1px solid #ddd;border-radius:6px;"><table style="border-collapse:collapse;width:100%;"><thead><tr><th style="${th}">#</th>`;
      COLS.forEach(c => {
        if (isDet(c) && !showDetails) return;
        contentHtml += `<th style="${th}">${esc(c)}<br><button data-copycol="${c}" style="cursor:pointer;font-size:10px;margin-top:4px;padding:2px 6px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#333;">Copiar</button></th>`;
      });
      contentHtml += `</tr></thead><tbody>`;

      slice.forEach((r, i) => {
        contentHtml += `<tr><td style="${td}color:#888;text-align:center;">${start + i + 1}</td>`;
        COLS.forEach(c => {
          if (isDet(c) && !showDetails) return;
          const val = r[c] === NF ? `<span style="color:#d32f2f;font-style:italic;">${NF}</span>` : esc(r[c]);
          contentHtml += `<td style="${td}">${val}</td>`;
        });
        contentHtml += `</tr>`;
      });
      contentHtml += `</tbody></table></div>`;
    } else {
      contentHtml += `<div style="color:#d32f2f;font-weight:bold;padding:30px;text-align:center;border:1px dashed #d32f2f;border-radius:8px;background:#fdf2f2;">${esc(data[0].Nombre)}</div>`;
    }

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;">
        <div style="display:flex;gap:10px;margin-bottom:15px;align-items:center;flex-wrap:wrap;">
          ${selectHtml}
          <button id="tw-toggle" style="cursor:pointer;font-size:12px;padding:8px 12px;background:${showDetails ? '#fff' : '#1a73e8'};color:${showDetails ? '#333' : '#fff'};border:1px solid #ccc;border-radius:6px;font-weight:bold;">${showDetails ? 'Ocultar Detalles' : 'Ver Detalles'}</button>
          <button id="tw-copy-all" style="cursor:pointer;font-size:12px;padding:8px 12px;background:#1a73e8;color:#fff;border:none;border-radius:6px;font-weight:bold;">Copiar Tabla</button>
        </div>
        <div style="flex:1;overflow:auto;">${contentHtml}</div>
        <div id="tw-msg" style="font-size:12px;color:#2e7d32;min-height:16px;margin-top:10px;font-weight:bold;"></div>
      </div>
    `;

    container.querySelector("#tw-group-select").onchange = (e) => {
      selectedGroup = e.target.value;
      renderTables(updateStatus);
    };

    container.querySelector("#tw-toggle").onclick = () => { showDetails = !showDetails; renderTables(updateStatus); };
    
    container.querySelectorAll("button[data-page]").forEach(b => {
      b.onclick = () => { pageIndexes[selectedGroup] = +b.dataset.page; renderTables(updateStatus); };
    });

    container.querySelectorAll("button[data-copycol]").forEach(b => {
      b.onclick = async () => {
        const col = b.dataset.copycol;
        const currPage = pageIndexes[selectedGroup] || 0;
        const slice = groupedData[selectedGroup].slice(currPage * PAGE, (currPage + 1) * PAGE);
        const plain = slice.map(r => (r[col] == null ? "" : r[col])).join("\n");
        
        const ok = await copyToClipboard(plain, plain);
        container.querySelector("#tw-msg").textContent = ok ? `✔ Columna ${col} copiada (Grupo ${selectedGroup})` : "Error al copiar";
      };
    });

    container.querySelector("#tw-copy-all").onclick = async () => {
        const currPage = pageIndexes[selectedGroup] || 0;
        const slice = groupedData[selectedGroup].slice(currPage * PAGE, (currPage + 1) * PAGE);
        
        let plain = COLS.join("\t") + "\n";
        slice.forEach(r => {
            plain += COLS.map(c => r[c] || "").join("\t") + "\n";
        });
        
        const ok = await copyToClipboard(plain, plain);
        container.querySelector("#tw-msg").textContent = ok ? `✔ Tabla del grupo ${selectedGroup} copiada` : "Error al copiar";
    };
  };

  setInterval(() => {
    if (!fab.isConnected) document.documentElement.appendChild(fab);
  }, 1000);

})();
