const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dt', {
  // Tasks
  todayTasks: (opts) => ipcRenderer.invoke('tasks:today', opts),
  unsyncedTasks: () => ipcRenderer.invoke('tasks:unsynced'),
  searchArchive: (query) => ipcRenderer.invoke('tasks:searchArchive', query),
  addTask: (data) => ipcRenderer.invoke('tasks:add', data),
  recentProjects: () => ipcRenderer.invoke('odoo:recentProjects'),
  searchProjects: (query) => ipcRenderer.invoke('odoo:searchProjects', query),
  searchStages: (data) => ipcRenderer.invoke('odoo:searchStages', data),
  autoDetectStageMappings: () => ipcRenderer.invoke('odoo:autoDetectStageMappings'),
  searchTasksInProject: (data) => ipcRenderer.invoke('odoo:searchTasksInProject', data),
  createOdooTask: (data) => ipcRenderer.invoke('odoo:createTask', data),
  doneTask: (id) => ipcRenderer.invoke('tasks:done', id),
  undoneTask: (id) => ipcRenderer.invoke('tasks:undone', id),
  moveTaskToToday: (id) => ipcRenderer.invoke('tasks:moveToToday', id),
  setPriority: (data) => ipcRenderer.invoke('tasks:setPriority', data),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
  unarchiveTask: (id) => ipcRenderer.invoke('tasks:unarchive', id),
  updateTask: (data) => ipcRenderer.invoke('tasks:update', data),
  addTimeslot: (data) => ipcRenderer.invoke('timeslots:add', data),
  resetTimeslots: (taskId) => ipcRenderer.invoke('timeslots:reset', taskId),
  syncUnsynced: (taskId) => ipcRenderer.invoke('tasks:syncUnsynced', taskId),
  getTask: (id) => ipcRenderer.invoke('tasks:get', id),

  // Timer
  startTimer: (taskId) => ipcRenderer.invoke('timer:start', taskId),
  stopTimer: () => ipcRenderer.invoke('timer:stop'),
  timerStatus: () => ipcRenderer.invoke('timer:status'),

  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // Odoo
  odooTest: () => ipcRenderer.invoke('odoo:test'),
  pollOdooNow: () => ipcRenderer.invoke('odoo:pollNow'),
  odooSearchTasks: (query) => ipcRenderer.invoke('odoo:searchTasks', query),
  getTaskBudgets: (odooTaskIds) => ipcRenderer.invoke('odoo:getTaskBudgets', odooTaskIds),
  linkOdooTask: (data) => ipcRenderer.invoke('tasks:linkOdoo', data),
  unlinkOdooTask: (taskId) => ipcRenderer.invoke('tasks:unlinkOdoo', taskId),

  // VSCode / Project
  saveVscode: (data) => ipcRenderer.invoke('tasks:saveVscode', data),
  openVscode: (taskId) => ipcRenderer.invoke('tasks:openVscode', taskId),
  openOdooTask: (odooTaskId) => ipcRenderer.invoke('odoo:openTask', odooTaskId),
  openTimesheetDay: (date) => ipcRenderer.invoke('odoo:openTimesheetDay', date),
  openTicket: (taskId) => ipcRenderer.invoke('tasks:openTicket', taskId),
  fetchCommits: (taskId) => ipcRenderer.invoke('tasks:fetchCommits', taskId),

  // Merge
  mergeTasks: (data) => ipcRenderer.invoke('tasks:merge', data),

  // Window
  setClickThrough: (ignore) => ipcRenderer.invoke('window:clickthrough', ignore),
  lastDaysTimesheet: (days) => ipcRenderer.invoke('odoo:lastDaysTimesheet', days),
  getEmployees: () => ipcRenderer.invoke('odoo:getEmployees'),
  getEmployeeTasks: (userId) => ipcRenderer.invoke('odoo:getEmployeeTasks', userId),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  doUpdate: () => ipcRenderer.invoke('app:doUpdate'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  focusWindow: () => ipcRenderer.invoke('window:focus'),
  expandWindow: () => ipcRenderer.invoke('window:expand'),
  collapseWindow: () => ipcRenderer.invoke('window:collapse'),
  setPinned: (pinned) => ipcRenderer.invoke('window:setPinned', pinned),
  getWindowPos: () => ipcRenderer.invoke('window:getPos'),
  setWindowPos: (x, y) => ipcRenderer.invoke('window:setPos', { x, y }),
  miniDragStart: () => ipcRenderer.invoke('window:miniDragStart'),
  miniDragEnd: () => ipcRenderer.invoke('window:miniDragEnd'),
  openSettings: () => ipcRenderer.invoke('window:openSettings'),
  openTaskWindow: (taskId) => ipcRenderer.invoke('window:openTask', taskId),

  // Odoo chatter
  postOdooMessage: (data) => ipcRenderer.invoke('odoo:postMessage', data),
  getOdooMessages: (taskId) => ipcRenderer.invoke('odoo:getMessages', taskId),

  // Events
  onTick: (cb) => ipcRenderer.on('tick', (_, data) => cb(data)),
  onMiniMode: (cb) => ipcRenderer.on('window:mini', (_, isMini) => cb(isMini)),
  onRefresh: (cb) => ipcRenderer.on('tasks:refresh', () => cb()),
  onTaskLoad: (cb) => ipcRenderer.on('task:load', (_, id) => cb(id)),

  // Task window initial id (from process.argv via additionalArguments)
  initialTaskId: (() => {
    const arg = (process.argv || []).find(a => typeof a === 'string' && a.startsWith('--task-id='));
    return arg ? parseInt(arg.split('=')[1], 10) || null : null;
  })(),
});
