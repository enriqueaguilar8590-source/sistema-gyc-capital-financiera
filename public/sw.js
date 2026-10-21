// Mínimo: permite mostrar avisos del sistema (iPhone/Android instalado) y abrir la app al tocarlos.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    const open = list.find(c => 'focus' in c);
    return open ? open.focus() : self.clients.openWindow('/');
  }));
});
