const stateAttrb = {
	'NAMEOFTHESTATE1': {
		name: 'READABLE NAME/DESCRIPTION',
		type: 'number|string|array|boolean...',
		read: true,
		write: false,
		role: 'value',
		// unit: 's|°|%...',
		// modify: ['multiply(3.6)', 'round(2)']
	},
	'Position': {
		name: 'Position of cover',
		type: 'number.',
		read: true,
		write: false,
		role: 'level.blind',
	},
	'Tilt': {
		name: 'Tilt of cover',
		type: 'number',
		read: true,
		write: false,
		role: 'level.tilt',
		// unit: 's|°|%...',
		// modify: ['multiply(3.6)', 'round(2)']
	},
	'Stop': {
		name: 'STOP cover',
		type: 'boolean',
		read: true,
		write: false,
		role: 'button',
		// unit: 's|°|%...',
		// modify: ['multiply(3.6)', 'round(2)']
	},
	'Button': {
		name: 'Button',
		type: 'boolean',
		read: true,
		write: true,
		role: 'button',
		// unit: 's|°|%...',
		// modify: ['multiply(3.6)', 'round(2)']
	},
};

module.exports = stateAttrb;