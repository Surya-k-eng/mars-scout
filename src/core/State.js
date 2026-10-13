// Small shared store. Setting a key also emits "state:<key>" so UI can react.
export class State {
  constructor(bus) {
    this.bus = bus;
    this.data = {};
  }
  get(key) {
    return this.data[key];
  }
  set(key, value) {
    this.data[key] = value;
    this.bus.emit('state:' + key, value);
  }
}