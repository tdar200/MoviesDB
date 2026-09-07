// The installed ares CLI otherwise forwards its inspector on all interfaces.
// This preload applies only to the child inspector process, never the app server.
import net from 'node:net';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
    if (typeof args[1] === 'function') args.splice(1, 0, '127.0.0.1');
    else args[1] = '127.0.0.1';
  } else if (args[0] && typeof args[0] === 'object' && 'port' in args[0]) {
    args[0] = { ...args[0], host: '127.0.0.1' };
  }
  return listen.apply(this, args);
};
