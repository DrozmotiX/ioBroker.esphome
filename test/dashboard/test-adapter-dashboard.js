#!/usr/bin/env node
'use strict';

/**
 * Test script to verify ESPHome Dashboard integration with adapter-style configuration
 * This tests the autopy virtual environment approach when possible
 */

async function testAdapterDashboard() {
	console.log('Testing adapter-style dashboard integration...');

	try {
		// Try to import autopy (same as main adapter)
		console.log('Attempting to create Python virtual environment via autopy...');

		const {getVenv} = await import('autopy');

		console.log('autopy loaded successfully, creating virtual environment...');

		// Create a virtual environment with esphome installed (same as adapter)
		const python = await getVenv({
			name: 'esphome-adapter-test',
			pythonVersion: '3.13.2',
			requirements: [
				{name: 'esphome', version: '>=2024.12.0'}, // Use recent stable version
				{name: 'pillow', version: '==10.4.0'}
			],
		});

		console.log('Python virtual environment created successfully via autopy');

		// Test that we can call esphome version
		return new Promise((resolve, reject) => {
			const versionProcess = python('esphome', ['version']);

			let output = '';
			versionProcess.stdout?.on('data', (data) => {
				output += data.toString();
			});

			versionProcess.stderr?.on('data', (data) => {
				output += data.toString();
			});

			versionProcess.on('exit', (code) => {
				if (code === 0) {
					console.log(`ESPHome version check successful: ${output.trim()}`);
					console.log('Adapter-style dashboard integration test passed!');
					resolve();
				} else {
					reject(new Error(`ESPHome version check failed with code ${code}: ${output}`));
				}
			});

			versionProcess.on('error', (err) => {
				reject(new Error(`Process error: ${err.message}`));
			});
		});

	} catch (error) {
		console.error(`Adapter dashboard test failed: ${error}`);

		// If autopy fails, that might be expected in some CI environments
		if (error.message && (error.message.includes('Blocked by') ||
                             error.message.includes('HttpError') ||
                             error.message.includes('network'))) {
			console.log('Network-related error detected - this may be expected in CI environment');
			console.log('Skipping autopy test due to network restrictions');
			return; // Don't fail the test for network issues
		}

		console.error(`Stack: ${error.stack}`);
		throw error;
	}
}

// Run the test
if (require.main === module) {
	testAdapterDashboard()
		.then(() => {
			console.log('Adapter dashboard test completed successfully');
			process.exit(0);
		})
		.catch((error) => {
			console.error(`Adapter dashboard test failed: ${error.message}`);
			process.exit(1);
		});
}

module.exports = { testAdapterDashboard };