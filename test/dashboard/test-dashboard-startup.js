#!/usr/bin/env node
'use strict';

/**
 * Test script to verify ESPHome Dashboard can start successfully
 * This version uses direct ESPHome installation instead of autopy virtual env
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

async function testDashboardStartup() {
    console.log('Starting ESPHome Dashboard test...');
    
    try {
        // Create temporary directory for ESPHome data
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esphome-test-'));
        console.log(`Using temp directory: ${tempDir}`);
        
        try {
            fs.mkdirSync(path.join(tempDir, 'esphome.0'), { recursive: true });
            console.log('ESPHome directory created');
        } catch (err) {
            console.log('ESPHome directory already exists or created');
        }
        
        console.log('Starting ESPHome Dashboard on port 6052...');
        
        // Start dashboard process using direct esphome command
        const dashboardProcess = spawn('esphome', [
            'dashboard', 
            '--port', '6052',
            path.join(tempDir, 'esphome.0')
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let dashboardStarted = false;
        let startupTimeout;
        
        return new Promise((resolve, reject) => {
            // Set a timeout for startup
            startupTimeout = setTimeout(() => {
                if (!dashboardStarted) {
                    console.error('Dashboard startup timeout');
                    dashboardProcess.kill('SIGTERM');
                    reject(new Error('Dashboard failed to start within timeout'));
                }
            }, 45000); // 45 second timeout
            
            // Monitor stdout for startup messages
            dashboardProcess.stdout?.on('data', (data) => {
                const output = data.toString();
                console.log(`[Dashboard stdout] ${output}`);
                
                // Look for successful startup indicators
                if (output.includes('Starting server') || 
                    output.includes('Running on') || 
                    output.includes('Application startup complete') ||
                    output.includes('Serving at')) {
                    console.log('Dashboard appears to be starting...');
                    
                    // Wait a moment then check if it's actually accessible
                    setTimeout(async () => {
                        try {
                            const http = require('http');
                            const req = http.get('http://localhost:6052/', (res) => {
                                console.log(`Dashboard HTTP response: ${res.statusCode}`);
                                if (res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 404) {
                                    // 404 is also OK as it means the server is responding
                                    dashboardStarted = true;
                                    clearTimeout(startupTimeout);
                                    console.log('ESPHome Dashboard started successfully!');
                                    
                                    // Clean shutdown
                                    dashboardProcess.kill('SIGTERM');
                                    
                                    // Clean up temp directory
                                    setTimeout(() => {
                                        try {
                                            fs.rmSync(tempDir, { recursive: true, force: true });
                                        } catch (cleanupErr) {
                                            console.warn(`Cleanup warning: ${cleanupErr.message}`);
                                        }
                                        resolve();
                                    }, 1000);
                                } else {
                                    reject(new Error(`Dashboard returned unexpected status: ${res.statusCode}`));
                                }
                            });
                            
                            req.on('error', (err) => {
                                console.log(`Dashboard not yet accessible: ${err.message}, continuing to wait...`);
                                // Try again in a few seconds if this was early
                                setTimeout(() => {
                                    const retryReq = http.get('http://localhost:6052/', (res) => {
                                        if (res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 404) {
                                            dashboardStarted = true;
                                            clearTimeout(startupTimeout);
                                            console.log('ESPHome Dashboard started successfully (on retry)!');
                                            dashboardProcess.kill('SIGTERM');
                                            setTimeout(() => {
                                                try {
                                                    fs.rmSync(tempDir, { recursive: true, force: true });
                                                } catch (cleanupErr) {
                                                    console.warn(`Cleanup warning: ${cleanupErr.message}`);
                                                }
                                                resolve();
                                            }, 1000);
                                        }
                                    });
                                    retryReq.on('error', () => {
                                        // If still not accessible after retry, that's OK, we'll timeout eventually
                                    });
                                }, 2000);
                            });
                            
                            req.setTimeout(5000);
                        } catch (httpError) {
                            console.error(`HTTP check error: ${httpError}`);
                        }
                    }, 2000); // Wait 2 seconds after seeing startup message
                }
            });
            
            // Monitor stderr
            dashboardProcess.stderr?.on('data', (data) => {
                const output = data.toString();
                console.log(`[Dashboard stderr] ${output}`);
                
                // ESPHome often logs INFO messages to stderr
                if (output.includes('INFO') && (
                    output.includes('Starting') || 
                    output.includes('Running') ||
                    output.includes('Application startup complete'))) {
                    console.log('Dashboard startup detected in stderr...');
                    
                    // Also check for HTTP accessibility when we see INFO messages
                    setTimeout(() => {
                        const http = require('http');
                        const req = http.get('http://localhost:6052/', (res) => {
                            if ((res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 404) && !dashboardStarted) {
                                dashboardStarted = true;
                                clearTimeout(startupTimeout);
                                console.log('ESPHome Dashboard started successfully (from stderr)!');
                                dashboardProcess.kill('SIGTERM');
                                setTimeout(() => {
                                    try {
                                        fs.rmSync(tempDir, { recursive: true, force: true });
                                    } catch (cleanupErr) {
                                        console.warn(`Cleanup warning: ${cleanupErr.message}`);
                                    }
                                    resolve();
                                }, 1000);
                            }
                        });
                        req.on('error', () => {
                            // Ignore HTTP errors at this stage
                        });
                    }, 3000);
                }
                
                // Look for fatal error conditions
                if (output.toLowerCase().includes('error') && 
                    !output.includes('INFO') && 
                    (output.includes('fatal') || output.includes('critical'))) {
                    console.error('Dashboard startup error detected');
                    reject(new Error(`Dashboard error: ${output}`));
                }
            });
            
            // Handle process events
            dashboardProcess.on('exit', (code, signal) => {
                console.log(`Dashboard process exited with code ${code}, signal ${signal}`);
                
                if (!dashboardStarted && code !== 0) {
                    reject(new Error(`Dashboard process exited prematurely: code ${code}`));
                }
            });
            
            dashboardProcess.on('error', (err) => {
                console.error(`Dashboard process error: ${err}`);
                reject(err);
            });
        });
        
    } catch (error) {
        console.error(`Dashboard test failed: ${error}`);
        console.error(`Stack: ${error.stack}`);
        process.exit(1);
    }
}

// Run the test
if (require.main === module) {
    testDashboardStartup()
        .then(() => {
            console.log('Dashboard test completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error(`Dashboard test failed: ${error.message}`);
            process.exit(1);
        });
}

module.exports = { testDashboardStartup };