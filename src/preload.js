const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dt', {
  // Tasks
  todayTasks: () => ipcRenderer.invoke('tasks:today'),
  unsyncedTasks: () => ipcRenderer.invoke('tasks:unsynced'),
  addTask: (data) => ipcRenderer.invoke('tasks:add', data),
  recentProjects: () => ipcRenderer.invoke('odoo:recentProjects'),
  searchProjects: (query) => ipcRenderer.invoke('odoo:searchProjects', query),
  searchTasksInProject: (data) => ipcRenderer.invoke('odoo:searchTasksInProject', data),
  createOdooTask: (data) => ipcRenderer.invoke('odoo:createTask', data),
  doneTask: (id) => ipcRenderer.invoke('tasks:done', id),
  undoneTask: (id) => ipcRenderer.invoke('tasks:undone', id),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
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
  odooSearchTasks: (query) => ipcRenderer.invoke('odoo:searchTasks', query),
  linkOdooTask: (data) => ipcRenderer.invoke('tasks:linkOdoo', data),
  unlinkOdooTask: (taskId) => ipcRenderer.invoke('tasks:unlinkOdoo', taskId),

  // VSCode / Project
  saveVscode: (data) => ipcRenderer.invoke('tasks:saveVscode', data),
  openVscode: (taskId) => ipcRenderer.invoke('tasks:openVscode', taskId),
  openOdooTask: (odooTaskId) => ipcRenderer.invoke('odoo:openTask', odooTaskId),
  openTicket: (taskId) => ipcRenderer.invoke('tasks:openTicket', taskId),
  fetchCommits: (taskId) => ipcRenderer.invoke('tasks:fetchCommits', taskId),

  // Merge
  mergeTasks: (data) => ipcRenderer.invoke('tasks:merge', data),

  // Window
  setClickThrough: (ignore) => ipcRenderer.invoke('window:clickthrough', ignore),
  getEmployees: () => ipcRenderer.invoke('odoo:getEmployees'),
  getEmployeeTasks: (userId) => ipcRenderer.invoke('odoo:getEmployeeTasks', userId),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  doUpdate: () => ipcRenderer.invoke('app:doUpdate'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  focusWindow: () => ipcRenderer.invoke('window:focus'),
  expandWindow: () => ipcRenderer.invoke('window:expand'),
  openSettings: () => ipcRenderer.invoke('window:openSettings'),

  // Events
  onTick: (cb) => ipcRenderer.on('tick', (_, data) => cb(data)),
  onMiniMode: (cb) => ipcRenderer.on('window:mini', (_, isMini) => cb(isMini)),
  onRefresh: (cb) => ipcRenderer.on('tasks:refresh', () => cb()),
});
