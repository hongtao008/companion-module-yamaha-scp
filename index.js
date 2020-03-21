// Control module for Yamaha Pro Audio, using SCP communication
// Jack Longden <Jack@atov.co.uk> 2019
// updated by Andrew Broughton <andy@checkcheckonetwo.com> Feb 2020

var tcp 			= require('../../tcp');
var instance_skel 	= require('../../instance_skel');
var scpNames 		= require('./scpNames.json');
var upgrade			= require('./upgrade');

const SCP_PARAMS 	= ['Ok', 'Command', 'Index', 'Address', 'X', 'Y', 'Min', 'Max', 'Default', 'Unit', 'Type', 'UI', 'RW', 'Scale'];
const SCP_VALS 		= ['Status', 'Command', 'Address', 'X', 'Y', 'Val', 'TxtVal'];


// Instance Setup
class instance extends instance_skel {
	
	constructor(system, id, config) {
		super(system, id, config);

		
		Object.assign(this, {
			...this.actions,
			...this.feedback,
			...upgrade
		});
		
		
		this.scpCommands = [];
		this.productName = '';
		this.scpVal 	 = [];	// Keeps track of values returned for Feedback purposes
		this.curScpVal	 = {};
		this.bankState 	 = new Object();

		this.addUpgradeScripts();
	}


	// Web config fields
	config_fields() {
		
		return [{
				type: 		'textinput',
				id: 		'host',
				label: 		'IP Address of Console',
				width: 		6,
				default: 	'192.168.0.128',
				regex: 		this.REGEX_IP
			},
			{
				type: 		'dropdown',
				id: 		'model',
				label: 		'Console Type',
				width: 		6,
				default: 	'CL/QL',
				choices: [
					{id: 'CL/QL', label: 'CL/QL Console'},
					{id: 'TF', label: 'TF Console'}
				]
			}
		]
	}

	
	// Change in Configuration
	updateConfig(config) {
		
		let fname = '';
		const FS  = require("fs");
		
		this.config = config;
		
		if(this.config.model == 'CL/QL') {
			fname = 'CL5 SCP Parameters-1.txt';
		}
		else {
			fname = 'TF5 SCP Parameters-1.txt';
		}

		// Read the DataFile
		let data = FS.readFileSync(`${__dirname}/${fname}`);
		this.scpCommands = this.parseData(data, SCP_PARAMS);

		this.scpCommands.sort((a, b) => {
			let acmd = a.Address.slice(a.Address.indexOf("/") + 1);
			let bcmd = b.Address.slice(b.Address.indexOf("/") + 1);
			return acmd.toLowerCase().localeCompare(bcmd.toLowerCase());
		})
		
		this.newConsole();
	}


	// Startup
	init() {
		this.updateConfig(this.config);
	}

	
	// Make each command line into an object that can be used to create the commands
	parseData(data, params) {
		
		let cmds    = [];
		let line    = [];
		const lines = data.toString().split("\x0A");
		
		for (let i = 0; i < lines.length; i++){
			// I'm not going to even try to explain this next line,
			// but it basically pulls out the space-separated values, except for spaces those that are inside quotes!
			line = lines[i].match(/(?:[^\s"]+|"[^"]*")+/g)
			if(line !== null && (['OK','NOTIFY'].indexOf(line[0].toUpperCase()) !== -1)){
				let scpCommand = new Object();
				
				for (var j = 0; j < line.length; j++){
					scpCommand[params[j]] = line[j].replace(/"/g,'');  // Get rid of any double quotes around the strings
				}
				cmds.push(scpCommand);
			}		
		}
		return cmds
	}


	// Whenever the console type changes, update the info
	newConsole() {
		
		this.log('info', `Device model= ${this.config.model}`);
		
		this.init_tcp();
		this.actions(); // Re-do the actions once the console is chosen
	}


	// Get info from a connected console
	getConsoleInfo() {
		this.socket.send(`devinfo productname\n`);
	}


	// Initialize TCP
	init_tcp() {
		
		let receivebuffer = '';
		let receivedcmd   = [];
		let foundCmd	  = {};
		let cmdIndex      = -1;

		if (this.socket !== undefined) {
			this.socket.destroy();
			delete this.socket;
		}

		if (this.config.host) {
			this.socket = new tcp(this.config.host, 49280);

			this.socket.on('status_change', (status, message) => {
				this.status(status, message);
			});

			this.socket.on('error', (err) => {
				this.status(this.STATE_ERROR, err);
				this.log('error', `Network error: ${err.message}`);
			});

			this.socket.on('connect', () => {
				this.status(this.STATE_OK);
				this.log('info', `Connected!`);
				this.getConsoleInfo();
				this.pollScp();
			});

			this.socket.on('data', (chunk) => {
				receivebuffer += chunk;
				
				this.log('debug', `Received from device: ${receivebuffer}`);

				if(receivebuffer.indexOf('OK devinfo productname') !== -1) {
				
					this.productName = receivebuffer.slice(receivebuffer.lastIndexOf(" "));
					this.log('info', `Device found: ${this.productName}`);
				
				} else {
				
					receivedcmd = this.parseData(receivebuffer, SCP_VALS); // Break out the parameters
					for(let i=0; i < receivedcmd.length; i++) {
						foundCmd = this.scpCommands.find(cmd => cmd.Address == receivedcmd[i].Address); // Find which command
						if(foundCmd !== undefined){
						
							cmdIndex = foundCmd.Index; // Find which command
							this.scpVal.push({i: 'scp_' + cmdIndex, cmd: receivedcmd[i]});
							do{
								this.curScpVal = this.scpVal.shift();
								this.checkFeedbacks(this.curScpVal.i);
							} while(this.scpVal.length > 0);
						
						} else {
						
							this.log('debug', `Unknown command received: ${receivedcmd[i].Address}`);
						
						}
					}
				}
				
				receivebuffer = '';	// Clear the buffer
			
			});
		}
	}

	
	// Module deletion
	destroy() {
	
		if (this.socket !== undefined) {
			this.socket.destroy();
		}

		this.log('debug', `destroyed ${this.id}`);
	}


	// Create the Actions & Feedbacks
	actions(system) {
		
		let commands  = {};
		let feedbacks = {};
		let scpCmd    = {};
		let valParams = {};
		let scpLabel  = '';

		for (let i = 0; i < this.scpCommands.length; i++) {
			
			scpCmd = this.scpCommands[i];
		
			if(this.config.model == 'TF' && scpCmd.Type == 'scene') {
				scpLabel = 'Scene/Bank'
			} else {
				scpLabel = scpCmd.Address.slice(scpCmd.Address.indexOf("/") + 1); // String after "MIXER:Current/"
			}
			
			// Add the commands from the data file. Action id's (action.action) are the SCP command number
			let scpAction = 'scp_' + scpCmd.Index;
			let scpLabels = scpLabel.split("/");
			let scpLabelIdx = 0;
			
			commands[scpAction] = {label: scpLabel, options: []};
			if(scpCmd.X > 1) {
					commands[scpAction].options = [
					{type: 'number', label: scpLabels[0], id: 'X', min: 1, max: scpCmd.X, default: 1, required: true, range: false}]
					scpLabelIdx = 1;
			}

			if(scpCmd.Y > 1) {
				if(this.config.model == "TF" && scpCmd.Type == 'scene') {
					valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Y', default: 'A', choices:[
						{id: 'A', label: 'A'},
						{id: 'B', label: 'B'}
					]}
				} else {
					valParams = {type: 'number', label: scpLabels[scpLabelIdx], id: 'Y', min: 1, max: scpCmd.Y, default: 1, required: true, range: false}
				}

				commands[scpAction].options.push(valParams);
			}
			
			if(scpLabelIdx < scpLabels.length - 1) scpLabelIdx++;
			
			switch(scpCmd.Type) {
				case 'integer':
					if(scpCmd.Max == 1) {
						valParams = {type: 'checkbox', label: 'On', id: 'Val', default: scpCmd.Default}
					} else {
						valParams = {
							type: 'number', label: scpLabels[scpLabelIdx], id: 'Val', min: scpCmd.Min, max: scpCmd.Max, default: parseInt(scpCmd.Default), required: true, range: false
						}
					}
					break;
				case 'string':
					if(scpLabel.startsWith("CustomFaderBank")) {
						valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, choices: scpNames.chNames}
					} else if(scpLabel.endsWith("Color")) {
						valParams = {type: 'dropdown', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, choices: scpNames.chColors}
					} else {
						valParams = {type: 'textinput', label: scpLabels[scpLabelIdx], id: 'Val', default: scpCmd.Default, regex: ''}
					}
					break;
				default:
					feedbacks[scpAction] = JSON.parse(JSON.stringify(commands[scpAction])); // Clone
					feedbacks[scpAction].options.push(
						{type: 'colorpicker', label: 'Foreground Colour', id: 'fg', default: this.rgb(0,0,0)},
						{type: 'colorpicker', label: 'Background Colour', id: 'bg', default: this.rgb(255,0,0)}
					)
					continue; // Don't push another parameter - In the case of a Scene message
			}
				
			commands[scpAction].options.push(valParams);
			
			feedbacks[scpAction] = JSON.parse(JSON.stringify(commands[scpAction])); // Clone
			feedbacks[scpAction].options.push(
					{type: 'colorpicker', label: 'Foreground Colour', id: 'fg', default: this.rgb(0,0,0)},
					{type: 'colorpicker', label: 'Background Colour', id: 'bg', default: this.rgb(255,0,0)}
			)
		}

		this.setActions(commands);
		this.setFeedbackDefinitions(feedbacks);
	}

	// Create the proper command string for an action or poll
	parseCmd(prefix, scpCmd, opt) {
		
		let scnPrefix  = '';
		let optX       = opt.X
		let optY       = ((opt.Y === undefined) ? 0 : opt.Y - 1);
		let optVal     = ''
		let scpCommand = this.scpCommands.find(cmd => 'scp_' + cmd.Index == scpCmd);
		if(scpCommand == undefined) {
			this.log('debug',`Invalid command: ${scpCmd}`)
			return;
		} 
		let cmdName = scpCommand.Address;			
		
		switch(scpCommand.Type) {
			case 'integer':
				cmdName = `${prefix} ${cmdName}`
				optX--; 				// ch #'s are 1 higher than the parameter
				optVal = ((prefix == 'set') ? 0 + opt.Val : ''); 	// Changes true/false to 1 0
				break;
			
			case 'string','binary':
				cmdName = `${prefix} ${cmdName}`
				optX--; 				// ch #'s are 1 higher than the parameter except with Custom Banks
				optVal = ((prefix == 'set') ? `"${opt.Val}"` : ''); // quotes around the string
				break;
	
			case 'scene':
				optY = '';
				optVal = '';
	
				if(prefix == 'set') {
					scnPrefix = 'ssrecall_ex';
					this.pollScp();		// so buttons with feedback reflect any changes
				} else {
					scnPrefix = 'sscurrent_ex';
					optX = '';
				}
	
				if(this.config.model == 'CL/QL') {
					cmdName = `${scnPrefix} ${cmdName}`;  		// Recall Scene for CL/QL
				} else {
					cmdName = `${scnPrefix} ${cmdName}${opt.Y}`; 	// Recall Scene for TF
				}
		}		
		
		return `${cmdName} ${optX} ${optY} ${optVal}`.trim(); 	// Command string to send to console
	}


	// Handle the Actions
	action(action) {
		
		let cmd = this.parseCmd('set', action.action, action.options);
		if (cmd !== undefined) {
			this.log('debug', `sending ${cmd} to ${this.config.host}`);
	
			if (this.socket !== undefined && this.socket.connected) {
				this.socket.send(`${cmd}\n`); 					// send it, but add a CR to the end
			}
			else {
				this.log('info', 'Socket not connected :(');
			}
		}
	}
	

	// Handle the Feedbacks
	feedback(feedback, bank) {

		const NO_CHANGE = 0b10;
		const MATCH     = 0b01;
		
		let match 	    = 0;
		let options     = feedback.options;
		let scpCommand  = this.scpCommands.find(cmd => 'scp_' + cmd.Index == feedback.type);

		function fbPageBank() {
			for(let page in feedbacks) {
				for(let bank in feedbacks[page]) {
					for(let fb in feedbacks[page][bank]) {
						// console.log(`fb.id = ${feedbacks[page][bank][fb].id}, feedback.id = ${feedback.id}`);
						if(feedbacks[page][bank][fb].id == feedback.id){
							return {pg: page, bk: bank}
						}
					}
				}
			}
		}

		let fbPB = fbPageBank();

//		console.log(`Page: ${fbPB.pg}, Bank: ${fbPB.bk}`);
			
		if((fbPB !== undefined && this.curScpVal.cmd !== undefined) && (scpCommand !== undefined)) {
			let Valopt = ((scpCommand.Type == 'integer') ? 0 + options.Val : `${options.Val}`) 	// 0 + value turns true/false into 1 0
			let ofs = ((scpCommand.Type == 'scene') ? 0 : 1); 									// Scenes are equal, channels are 1 higher
			
			if(this.bankState[`${fbPB.pg}:${fbPB.bk}`] == undefined) {
				this.bankState[`${fbPB.pg}:${fbPB.bk}`] = {color: bank.color, bgcolor: bank.bgcolor}
			}
			
/*			
			console.log(`Feedback: ${feedback.type}:${this.curScpVal.cmd.Address}`);
			console.log(`options.X: ${options.X}, this.curScpVal.X: ${parseInt(this.curScpVal.cmd.X) + ofs}`);
			console.log(`options.Y: ${options.Y}, this.curScpVal.Y: ${parseInt(this.curScpVal.cmd.Y) + ofs}`);
			console.log(`Valopt: ${Valopt}, this.curScpVal.Val: ${this.curScpVal.cmd.Val}`);
*/						
			if(options.X == parseInt(this.curScpVal.cmd.X) + ofs){
				match = MATCH;
			} else {
				match = NO_CHANGE;
			}

//			console.log(`x-match = ${match}`);

			if(options.Y !== undefined) {
				if(options.Y !== parseInt(this.curScpVal.cmd.Y) + ofs) {
					match = NO_CHANGE;
				}
			}

//			console.log(`y-match = ${match}`);

			if(this.curScpVal.cmd.Val !== undefined) {
				if(match == MATCH) {
					if(Valopt == this.curScpVal.cmd.Val) {
						match = MATCH;
					} else {
						match = 0;
					}
				}
			} else {
				match = (match | MATCH);
			}
			
//			console.log(`final match = ${match}`);

			if(match == MATCH) {
//				console.log('Match!');
				this.bankState[`${fbPB.pg}:${fbPB.bk}`] = {color: options.fg, bgcolor: options.bg};
			} else if(match !== NO_CHANGE) {
//				console.log('No Match');
				this.bankState[`${fbPB.pg}:${fbPB.bk}`] = {color: bank.color, bgcolor: bank.bgcolor}
			}
		}
		
//		console.log('\n');

		return this.bankState[`${fbPB.pg}:${fbPB.bk}`]; // return the old value if no match, but the new value if there is a match	
	}


	// Poll the console for it's status to update buttons via feedback
	pollScp() {
	
		for (let page in feedbacks) {
			for (let bank in feedbacks[page]) {
				for (let fb in feedbacks[page][bank]) {
					// console.log(`feedback[${page}][${bank}][${fb}] = ${Object.entries(feedbacks[page][bank][fb])}`);
					let cmd = this.parseCmd('get', feedbacks[page][bank][fb].type, feedbacks[page][bank][fb].options);
					if(cmd !== undefined){
						this.log('debug', `sending ${cmd} to ${this.config.host}`);
						this.socket.send(`${cmd}\n`)				
					}
				}
			}
		}
	}

}

exports = module.exports = instance;