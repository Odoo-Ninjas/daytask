(function () {
  if (typeof window === 'undefined' || window.dt) return;

  const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(r => r.json());
  const get = (url) => fetch(url).then(r => r.json());

  // SSE event bus
  let es = null;
  const handlers = {};
  function onEvent(name, cb) {
    if (!handlers[name]) handlers[name] = [];
    handlers[name].push(cb);
    if (!es) connectSSE();
  }
  function connectSSE() {
    es = new EventSource('/api/events');
    ['tick', 'refresh', 'task:load'].forEach(name => {
      es.addEventListener(name, (e) => {
        const data = e.data ? JSON.parse(e.data) : undefined;
        (handlers[name] || []).forEach(cb => cb(data));
      });
    });
    es.onerror = () => { es.close(); es = null; setTimeout(connectSSE, 3000); };
  }

  // Make the app responsive for web/iPad — runs only when not in Electron
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
      html, body {
        width: 100% !important;
        max-width: 100% !important;
        height: 100vh !important;
        overflow: auto !important;
        -webkit-app-region: none !important;
      }
      #app {
        width: 100% !important;
        max-width: 100% !important;
        height: 100vh;
      }
    `;
    document.head.appendChild(style);
  });

  window.dt = {
    __isWeb: true,

    todayTasks: () => get('/api/tasks/today'),
    unsyncedTasks: () => get('/api/tasks/unsynced'),
    addTask: (data) => post('/api/tasks', data),
    doneTask: (id) => post(`/api/tasks/${id}/done`),
    undoneTask: (id) => post(`/api/tasks/${id}/undone`),
    deleteTask: (id) => post(`/api/tasks/${id}/delete`),
    updateTask: (data) => post('/api/tasks/update', data),
    getTask: (id) => get(`/api/tasks/${id}`),
    setPriority: (data) => post('/api/tasks/priority', data),
    linkOdooTask: (data) => post('/api/tasks/link-odoo', data),
    unlinkOdooTask: (taskId) => post(`/api/tasks/${taskId}/unlink-odoo`),
    syncUnsynced: (taskId) => post(`/api/tasks/${taskId}/sync`),
    mergeTasks: (data) => post('/api/tasks/merge', data),

    addTimeslot: (data) => post('/api/timeslots', data),
    resetTimeslots: (taskId) => post(`/api/tasks/${taskId}/timeslots/reset`),

    startTimer: (taskId) => post(`/api/timer/start/${taskId}`),
    stopTimer: () => post('/api/timer/stop'),
    timerStatus: () => get('/api/timer/status'),

    getConfig: () => get('/api/config'),
    saveConfig: (cfg) => post('/api/config', cfg),

    odooTest: () => get('/api/odoo/test'),
    odooSearchTasks: (query) => post('/api/odoo/search-tasks', { query }),
    recentProjects: () => get('/api/odoo/recent-projects'),
    searchProjects: (query) => post('/api/odoo/search-projects', { query }),
    searchStages: (data) => post('/api/odoo/search-stages', data),
    autoDetectStageMappings: () => post('/api/odoo/auto-detect-stages'),
    searchTasksInProject: (data) => post('/api/odoo/search-tasks-in-project', data),
    createOdooTask: (data) => post('/api/odoo/create-task', data),
    lastDaysTimesheet: (days) => get(`/api/odoo/timesheet/${days}`),
    getEmployees: () => get('/api/odoo/employees'),
    getEmployeeTasks: (userId) => get(`/api/odoo/employees/${userId}/tasks`),
    postOdooMessage: (data) => post('/api/odoo/message', data),
    getOdooMessages: (taskId) => get(`/api/odoo/messages/${taskId}`),
    openOdooTask: (odooTaskId) => post('/api/odoo/open-task', { odooTaskId }).then(r => { if (r.ok && r.url) window.open(r.url, '_blank'); }),

    saveVscode: (data) => post('/api/vscode/save', data),
    openVscode: (taskId) => post(`/api/vscode/open/${taskId}`),
    openTicket: (taskId) => post(`/api/tasks/${taskId}/open-ticket`).then(r => { if (r.ok && r.url) window.open(r.url, '_blank'); }),
    fetchCommits: (taskId) => get(`/api/tasks/${taskId}/commits`),

    // Window management — no-ops in web context
    setClickThrough: () => Promise.resolve(),
    hideWindow: () => Promise.resolve(),
    focusWindow: () => Promise.resolve(),
    expandWindow: () => Promise.resolve(),
    collapseWindow: () => Promise.resolve(),
    setPinned: () => Promise.resolve(),
    getWindowPos: () => Promise.resolve([0, 0]),
    setWindowPos: () => Promise.resolve(),
    miniDragStart: () => Promise.resolve(),
    miniDragEnd: () => Promise.resolve(),
    openSettings: () => { window.open('/settings', '_blank'); return Promise.resolve(); },
    openTaskWindow: (taskId) => { window.open(`/task?id=${taskId}`, '_blank'); return Promise.resolve(); },

    checkUpdate: () => Promise.resolve({ isGit: false, currentVersion: 'web', isNewer: false }),
    doUpdate: () => Promise.resolve(),
    getVersion: () => Promise.resolve('web'),

    onTick: (cb) => onEvent('tick', cb),
    onMiniMode: () => {},
    onRefresh: (cb) => onEvent('refresh', cb),
    onTaskLoad: (cb) => onEvent('task:load', cb),

    initialTaskId: (() => {
      const p = new URLSearchParams(window.location.search);
      return parseInt(p.get('id'), 10) || null;
    })(),
  };
})();
