const stateAttrb = {
  NAMEOFTHESTATE1: {
    name: "READABLE NAME/DESCRIPTION",
    type: "number|string|array|boolean...",
    read: true,
    write: false,
    role: "value",
    // unit: 's|°|%...',
    // modify: ['multiply(3.6)', 'round(2)']
  },
  Position: {
    name: "Position of cover",
    type: "number.",
    read: true,
    write: false,
    role: "level.blind",
  },
  Tilt: {
    name: "Tilt of cover",
    type: "number",
    read: true,
    write: false,
    role: "level.tilt",
    // unit: 's|°|%...',
    // modify: ['multiply(3.6)', 'round(2)']
  },
  Stop: {
    name: "STOP cover",
    type: "boolean",
    read: true,
    write: false,
    role: "button",
    // unit: 's|°|%...',
    // modify: ['multiply(3.6)', 'round(2)']
  },
  Button: {
    name: "Button",
    type: "boolean",
    read: true,
    write: true,
    role: "button",
    // unit: 's|°|%...',
    // modify: ['multiply(3.6)', 'round(2)']
  },
  LockState: {
    name: "Lock State",
    type: "number",
    read: true,
    write: false,
    role: "value.lock",
    // 0 = NONE, 1 = LOCKED, 2 = UNLOCKED, 3 = JAMMED, 4 = LOCKING, 5 = UNLOCKING
  },
  LockCommand: {
    name: "Lock Command",
    type: "number",
    read: true,
    write: true,
    role: "switch.lock",
    // 0 = UNLOCK, 1 = LOCK, 2 = OPEN
  },
};

module.exports = stateAttrb;
//# sourceMappingURL=stateAttr.js.map
