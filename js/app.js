/* =====================================================
   GENERATE ARTIKEL — app.js
   Vanilla JS | LocalStorage | WeizeRouter Streaming API
   ===================================================== */

'use strict';

/* =====================================================
   MODULE: Storage
   ===================================================== */
const Storage = (() => {
  const KEYS = {
    settings: 'ga_settings',
    history:  'ga_history',
  };

  const DEFAULT_PROMPT = `Kamu adalah penulis artikel profesional berbahasa Indonesia.

Tulis artikel lengkap dengan judul: "{{judul}}"
Sub tema artikel: {{sub_tema}}
{{lead}}
Panjang artikel: sekitar {{panjang}} kata.

Ketentuan penulisan:
- Gunakan bahasa Indonesia yang baku, jelas, dan mudah dipahami
- Struktur artikel: pendahuluan, isi (beberapa sub-bagian), dan penutup/kesimpulan
- Gunakan paragraf yang terstruktur dan mudah dibaca
- Jangan sertakan judul artikel di dalam teks (sudah ada di judul)
- Langsung tulis isi artikelnya tanpa kalimat pembuka seperti "Berikut adalah artikel..."`;

  function getSettings() {
    try {
      const raw = localStorage.getItem(KEYS.settings);
      const data = raw ? JSON.parse(raw) : {};
      return {
        apiKey:    data.apiKey    || '',
        modelId:   data.modelId   || 'wz/gpt-5.5',
        prompt:    data.prompt    || DEFAULT_PROMPT,
      };
    } catch {
      return { apiKey: '', modelId: 'wz/gpt-5.5', prompt: DEFAULT_PROMPT };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  }

  function getHistory() {
    try {
      const raw = localStorage.getItem(KEYS.history);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveHistory(history) {
    localStorage.setItem(KEYS.history, JSON.stringify(history));
  }

  function addHistoryItem(item) {
    const history = getHistory();
    history.unshift(item); // newest first
    if (history.length > 20) history.pop(); // keep max 20
    saveHistory(history);
  }

  function deleteHistoryItem(id) {
    const history = getHistory().filter(h => h.id !== id);
    saveHistory(history);
  }

  return { getSettings, saveSettings, getHistory, addHistoryItem, deleteHistoryItem, DEFAULT_PROMPT };
})();

/* =====================================================
   MODULE: API
   ===================================================== */
const API = (() => {
  const BASE_URL = 'https://weizerouter.web.id/v1';

  /**
   * Replace template variables in the prompt string.
   * {{judul}}, {{sub_tema}}, {{lead}}, {{panjang}}
   */
  function buildPrompt(template, formData) {
    const leadText = formData.lead
      ? `Lead/Pembuka: ${formData.lead}`
      : '';

    return template
      .replace(/\{\{judul\}\}/g,    formData.judul)
      .replace(/\{\{sub_tema\}\}/g, formData.subTema)
      .replace(/\{\{lead\}\}/g,     leadText)
      .replace(/\{\{panjang\}\}/g,  String(formData.panjang));
  }

  /**
   * Generate article with streaming.
   * @param {Object} formData  - { judul, lead, subTema, panjang }
   * @param {Object} settings  - { apiKey, modelId, prompt }
   * @param {Function} onChunk - called with each text chunk (string)
   * @param {Function} onDone  - called when stream finishes
   * @param {Function} onError - called with error message (string)
   */
  async function generateArticle(formData, settings, onChunk, onDone, onError) {
    if (!settings.apiKey) {
      onError('API Key belum diatur. Silakan buka Pengaturan dan masukkan API Key Anda.');
      return;
    }

    const systemPrompt = buildPrompt(settings.prompt, formData);

    const body = {
      model:    settings.modelId || 'wz/gpt-5.5',
      stream:   true,
      messages: [
        { role: 'system',  content: systemPrompt },
        { role: 'user',    content: `Buat artikel dengan judul: "${formData.judul}"` },
      ],
    };

    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let errMsg = `Gagal menghubungi API (HTTP ${response.status})`;
        if (response.status === 401) errMsg = 'API Key tidak valid atau sudah kadaluarsa.';
        else if (response.status === 429) errMsg = 'Terlalu banyak permintaan. Coba lagi sebentar.';
        else if (response.status === 500) errMsg = 'Server API sedang bermasalah. Coba lagi nanti.';
        else if (errText) {
          try {
            const parsed = JSON.parse(errText);
            errMsg = parsed?.error?.message || errMsg;
          } catch { /* ignore */ }
        }
        onError(errMsg);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            onDone();
            return;
          }

          try {
            const json = JSON.parse(dataStr);
            const delta = json?.choices?.[0]?.delta?.content;
            if (delta) onChunk(delta);
          } catch { /* skip malformed chunk */ }
        }
      }

      onDone();

    } catch (err) {
      if (err.name === 'AbortError') {
        onError('Permintaan dibatalkan.');
      } else if (!navigator.onLine) {
        onError('Tidak ada koneksi internet. Periksa koneksi Anda.');
      } else {
        onError(`Terjadi kesalahan: ${err.message}`);
      }
    }
  }

  return { generateArticle };
})();

/* =====================================================
   MODULE: UI Utilities
   ===================================================== */
const UI = (() => {

  /* ---- Toast ---- */
  let toastContainer = null;

  function ensureToastContainer() {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'toast-container';
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  function showToast(message, type = '', duration = 3000) {
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast${type ? ' ' + type : ''}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('out');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, duration);
  }

  /* ---- Format date ---- */
  function formatDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  return { showToast, formatDate };
})();

/* =====================================================
   APP CONTROLLER
   ===================================================== */
const App = (() => {

  /* ---- State ---- */
  let isGenerating  = false;
  let currentText   = '';
  let lastFormData  = null;

  /* ---- DOM refs ---- */
  const $ = id => document.getElementById(id);

  const dom = {
    // Form
    form:          $('articleForm'),
    inputJudul:    $('inputJudul'),
    inputLead:     $('inputLead'),
    inputSubTema:  $('inputSubTema'),
    inputPanjang:  $('inputPanjang'),
    errorJudul:    $('errorJudul'),
    errorSubTema:  $('errorSubTema'),
    btnGenerate:   $('btnGenerate'),
    // Result
    resultEmpty:   $('resultEmpty'),
    resultContent: $('resultContent'),
    resultActions: $('resultActions'),
    btnCopy:       $('btnCopy'),
    btnRegenerate: $('btnRegenerate'),
    btnDelete:     $('btnDelete'),
    // Sidebar
    sidebar:          $('sidebar'),
    sidebarBackdrop:  $('sidebarBackdrop'),
    btnSidebar:       $('btnSidebar'),
    sidebarClose:     $('sidebarClose'),
    historyList:      $('historyList'),
    historyEmpty:     $('historyEmpty'),
    // Modal
    modal:            $('modalSettings'),
    modalBackdrop:    $('modalBackdrop'),
    btnSettings:      $('btnSettings'),
    modalClose:       $('modalClose'),
    btnSettingsCancel:$('btnSettingsCancel'),
    btnSettingsSave:  $('btnSettingsSave'),
    settingApiKey:    $('settingApiKey'),
    settingModelId:   $('settingModelId'),
    settingPrompt:    $('settingPrompt'),
    btnToggleApiKey:  $('btnToggleApiKey'),
    // Tabs
    tabBtns:       document.querySelectorAll('.tab-btn'),
    panelInput:    $('panelInput'),
    panelResult:   $('panelResult'),
  };

  /* =====================================================
     FORM VALIDATION
     ===================================================== */
  function validateForm() {
    let valid = true;

    if (!dom.inputJudul.value.trim()) {
      dom.errorJudul.textContent = 'Judul artikel wajib diisi.';
      dom.inputJudul.classList.add('error');
      valid = false;
    } else {
      dom.errorJudul.textContent = '';
      dom.inputJudul.classList.remove('error');
    }

    if (!dom.inputSubTema.value.trim()) {
      dom.errorSubTema.textContent = 'Sub tema wajib diisi.';
      dom.inputSubTema.classList.add('error');
      valid = false;
    } else {
      dom.errorSubTema.textContent = '';
      dom.inputSubTema.classList.remove('error');
    }

    return valid;
  }

  function clearErrors() {
    dom.errorJudul.textContent  = '';
    dom.errorSubTema.textContent = '';
    dom.inputJudul.classList.remove('error');
    dom.inputSubTema.classList.remove('error');
  }

  /* =====================================================
     GENERATE ARTICLE
     ===================================================== */
  function getFormData() {
    return {
      judul:   dom.inputJudul.value.trim(),
      lead:    dom.inputLead.value.trim(),
      subTema: dom.inputSubTema.value.trim(),
      panjang: parseInt(dom.inputPanjang.value, 10) || 1000,
    };
  }

  function setGeneratingState(generating) {
    isGenerating = generating;
    dom.btnGenerate.disabled    = generating;
    dom.btnRegenerate.disabled  = generating;

    if (generating) {
      dom.btnGenerate.innerHTML = `
        <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
        Membuat Artikel...`;
    } else {
      dom.btnGenerate.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Buat Artikel`;
    }
  }

  function showResultArea() {
    dom.resultEmpty.style.display   = 'none';
    dom.resultContent.style.display = 'block';
  }

  function hideResultArea() {
    dom.resultEmpty.style.display   = '';
    dom.resultContent.style.display = '';
    dom.resultContent.textContent   = '';
    currentText = '';
  }

  function startGenerate(formData) {
    const settings = Storage.getSettings();
    lastFormData = formData;
    currentText  = '';

    setGeneratingState(true);
    showResultArea();
    dom.resultContent.textContent = '';
    dom.resultContent.classList.add('streaming');
    dom.resultActions.style.visibility = 'hidden';

    // On mobile: switch to result tab
    switchTab('result');

    API.generateArticle(
      formData,
      settings,
      // onChunk
      (chunk) => {
        currentText += chunk;
        dom.resultContent.textContent = currentText;
        // Auto scroll
        dom.panelResult.scrollTop = dom.panelResult.scrollHeight;
      },
      // onDone
      () => {
        dom.resultContent.classList.remove('streaming');
        setGeneratingState(false);
        dom.resultActions.style.visibility = '';

        // Save to history
        if (currentText.trim()) {
          Storage.addHistoryItem({
            id:        Date.now().toString(),
            judul:     formData.judul,
            subTema:   formData.subTema,
            isi:       currentText,
            timestamp: Date.now(),
          });
          renderHistory();
        }
      },
      // onError
      (errMsg) => {
        dom.resultContent.classList.remove('streaming');
        setGeneratingState(false);
        dom.resultContent.textContent = '';
        hideResultArea();
        UI.showToast(errMsg, 'error', 5000);
      }
    );
  }

  /* =====================================================
     FORM SUBMIT
     ===================================================== */
  function onFormSubmit(e) {
    e.preventDefault();
    if (isGenerating) return;
    if (!validateForm()) return;
    startGenerate(getFormData());
  }

  /* =====================================================
     ACTION BUTTONS: Salin, Generate Ulang, Hapus
     ===================================================== */
  function onCopy() {
    if (!currentText) return;
    navigator.clipboard.writeText(currentText).then(() => {
      const orig = dom.btnCopy.innerHTML;
      dom.btnCopy.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Tersalin!`;
      dom.btnCopy.style.color = 'var(--color-success)';
      dom.btnCopy.style.borderColor = 'var(--color-success)';
      setTimeout(() => {
        dom.btnCopy.innerHTML = orig;
        dom.btnCopy.style.color = '';
        dom.btnCopy.style.borderColor = '';
      }, 2000);
    }).catch(() => {
      UI.showToast('Gagal menyalin teks.', 'error');
    });
  }

  function onRegenerate() {
    if (isGenerating || !lastFormData) return;
    startGenerate(lastFormData);
  }

  let deleteConfirmTimer = null;
  function onDelete() {
    if (isGenerating) return;

    if (dom.btnDelete.dataset.confirm === 'true') {
      // Confirmed — do delete
      clearTimeout(deleteConfirmTimer);
      delete dom.btnDelete.dataset.confirm;
      dom.btnDelete.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        Hapus`;
      dom.btnDelete.style.color = '';
      dom.btnDelete.style.borderColor = '';
      // Reset form & result
      dom.form.reset();
      dom.inputPanjang.value = '1000';
      clearErrors();
      hideResultArea();
      dom.resultActions.style.visibility = 'hidden';
      currentText  = '';
      lastFormData = null;
      // On mobile: go back to input tab
      switchTab('input');
    } else {
      // First click — ask for confirm
      dom.btnDelete.dataset.confirm = 'true';
      dom.btnDelete.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Yakin?`;
      dom.btnDelete.style.color = 'var(--color-danger)';
      dom.btnDelete.style.borderColor = 'var(--color-danger)';
      deleteConfirmTimer = setTimeout(() => {
        delete dom.btnDelete.dataset.confirm;
        dom.btnDelete.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Hapus`;
        dom.btnDelete.style.color = '';
        dom.btnDelete.style.borderColor = '';
      }, 3000);
    }
  }

  /* =====================================================
     SIDEBAR RIWAYAT
     ===================================================== */
  function openSidebar() {
    dom.sidebar.classList.add('open');
    dom.sidebarBackdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    dom.sidebar.classList.remove('open');
    dom.sidebarBackdrop.classList.remove('visible');
    document.body.style.overflow = '';
  }

  function renderHistory() {
    const history = Storage.getHistory();
    // Remove all items except the empty placeholder
    Array.from(dom.historyList.querySelectorAll('.history-item')).forEach(el => el.remove());

    if (history.length === 0) {
      dom.historyEmpty.style.display = '';
      return;
    }

    dom.historyEmpty.style.display = 'none';

    history.forEach(item => {
      const li = document.createElement('li');
      li.className = 'history-item';
      li.dataset.id = item.id;
      li.innerHTML = `
        <div class="history-item-text">
          <div class="history-item-title" title="${escapeHtml(item.judul)}">${escapeHtml(item.judul)}</div>
          <div class="history-item-meta">${escapeHtml(item.subTema)} &bull; ${UI.formatDate(item.timestamp)}</div>
        </div>
        <button class="history-item-delete" title="Hapus riwayat ini" data-id="${escapeHtml(item.id)}" aria-label="Hapus riwayat">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>`;

      // Click on item text → load article
      li.querySelector('.history-item-text').addEventListener('click', () => {
        loadHistoryItem(item);
        closeSidebar();
      });

      // Delete button
      li.querySelector('.history-item-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        Storage.deleteHistoryItem(item.id);
        renderHistory();
        UI.showToast('Riwayat dihapus.', '', 2000);
      });

      dom.historyList.appendChild(li);
    });
  }

  function loadHistoryItem(item) {
    currentText  = item.isi;
    lastFormData = {
      judul:   item.judul,
      lead:    '',
      subTema: item.subTema,
      panjang: 1000,
    };
    // Populate form
    dom.inputJudul.value   = item.judul;
    dom.inputSubTema.value = item.subTema;
    dom.inputLead.value    = '';
    dom.inputPanjang.value = '1000';

    showResultArea();
    dom.resultContent.textContent   = item.isi;
    dom.resultContent.classList.remove('streaming');
    dom.resultActions.style.visibility = '';
    switchTab('result');
  }

  /* =====================================================
     MODAL PENGATURAN
     ===================================================== */
  function openModal() {
    const s = Storage.getSettings();
    dom.settingApiKey.value  = s.apiKey;
    dom.settingModelId.value = s.modelId;
    dom.settingPrompt.value  = s.prompt;
    dom.modal.classList.add('open');
    dom.modalBackdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    dom.modal.classList.remove('open');
    dom.modalBackdrop.classList.remove('visible');
    document.body.style.overflow = '';
  }

  function saveModalSettings() {
    const apiKey  = dom.settingApiKey.value.trim();
    const modelId = dom.settingModelId.value.trim() || 'wz/gpt-5.5';
    const prompt  = dom.settingPrompt.value.trim()  || Storage.DEFAULT_PROMPT;
    Storage.saveSettings({ apiKey, modelId, prompt });
    closeModal();
    UI.showToast('Pengaturan berhasil disimpan.', 'success', 2500);
  }

  function toggleApiKeyVisibility() {
    const isPassword = dom.settingApiKey.type === 'password';
    dom.settingApiKey.type = isPassword ? 'text' : 'password';
    dom.btnToggleApiKey.querySelector('.icon-eye').style.display     = isPassword ? 'none' : '';
    dom.btnToggleApiKey.querySelector('.icon-eye-off').style.display = isPassword ? ''     : 'none';
  }

  /* =====================================================
     TAB SWITCHING (mobile)
     ===================================================== */
  function switchTab(tabName) {
    const isMobile = window.innerWidth <= 768;

    dom.tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    if (isMobile) {
      dom.panelInput.classList.toggle('active',  tabName === 'input');
      dom.panelResult.classList.toggle('active', tabName === 'result');
    } else {
      // Desktop: both always visible
      dom.panelInput.classList.add('active');
      dom.panelResult.classList.add('active');
    }
  }

  /* =====================================================
     HELPERS
     ===================================================== */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* =====================================================
     INIT
     ===================================================== */
  function init() {
    // Initial layout setup
    handleResize();
    window.addEventListener('resize', handleResize);

    // Form
    dom.form.addEventListener('submit', onFormSubmit);

    // Clear error on input
    dom.inputJudul.addEventListener('input', () => {
      if (dom.inputJudul.value.trim()) {
        dom.errorJudul.textContent = '';
        dom.inputJudul.classList.remove('error');
      }
    });
    dom.inputSubTema.addEventListener('input', () => {
      if (dom.inputSubTema.value.trim()) {
        dom.errorSubTema.textContent = '';
        dom.inputSubTema.classList.remove('error');
      }
    });

    // Result action buttons
    dom.btnCopy.addEventListener('click', onCopy);
    dom.btnRegenerate.addEventListener('click', onRegenerate);
    dom.btnDelete.addEventListener('click', onDelete);

    // Sidebar
    dom.btnSidebar.addEventListener('click', () => { renderHistory(); openSidebar(); });
    dom.sidebarClose.addEventListener('click', closeSidebar);
    dom.sidebarBackdrop.addEventListener('click', closeSidebar);

    // Modal
    dom.btnSettings.addEventListener('click', openModal);
    dom.modalClose.addEventListener('click', closeModal);
    dom.btnSettingsCancel.addEventListener('click', closeModal);
    dom.btnSettingsSave.addEventListener('click', saveModalSettings);
    dom.modalBackdrop.addEventListener('click', closeModal);
    dom.btnToggleApiKey.addEventListener('click', toggleApiKeyVisibility);

    // Tabs
    dom.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Keyboard: Escape closes sidebar/modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (dom.modal.classList.contains('open'))   closeModal();
        if (dom.sidebar.classList.contains('open')) closeSidebar();
      }
    });

    // Initial state: hide result actions
    dom.resultActions.style.visibility = 'hidden';
  }

  function handleResize() {
    const isMobile = window.innerWidth <= 768;
    if (!isMobile) {
      // On desktop: always show both panels
      dom.panelInput.classList.add('active');
      dom.panelResult.classList.add('active');
    } else {
      // On mobile: show only the active tab's panel
      const activeTab = Array.from(dom.tabBtns).find(b => b.classList.contains('active'));
      const tabName = activeTab ? activeTab.dataset.tab : 'input';
      dom.panelInput.classList.toggle('active',  tabName === 'input');
      dom.panelResult.classList.toggle('active', tabName === 'result');
    }
  }

  return { init };
})();

/* =====================================================
   BOOTSTRAP
   ===================================================== */
document.addEventListener('DOMContentLoaded', App.init);
