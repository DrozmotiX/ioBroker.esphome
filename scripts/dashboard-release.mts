import {$} from 'execa';
import fetch from 'node-fetch';
import pkg from '../package.json' assert {type: 'json'};

interface DashboardConfig {
    python_version: string;
    dashboard_version: string;
}

const dashboardConfig: DashboardConfig = pkg.iobroker_esphome_adapter;
const $$ = $({stdio: 'inherit'});

async function run(): Promise<void> {
    const {dashboard_version: currentDashboardVersion, python_version: currentPythonVersion} = dashboardConfig;

    const latestDashboardVersion: string = await getLatestDashboardVersion();
    const latestPythonVersion: string = await getLatestPythonVersion();

    console.info(`current dashboard version: ${currentDashboardVersion} - latest: ${latestDashboardVersion}`);
    console.info(`current python version: ${currentPythonVersion} - latest: ${latestPythonVersion}`);

    if ((currentDashboardVersion != latestDashboardVersion) || (currentPythonVersion != latestPythonVersion)) {
        console.info('new version(s) found');

        $$`npm pkg set iobroker_esphome_adapter.dashboard_version=${latestDashboardVersion}`;
        $$`npm pkg set iobroker_esphome_adapter.python_version=${latestPythonVersion}`;

        const UPDATE_MSG = `(CI) Update integrated Dashboard from Version ${currentDashboardVersion} to ${latestDashboardVersion} and Python from Version ${currentPythonVersion} to ${latestDashboardVersion}.`

        // $$`git commit --all --message "${UPDATE_MSG}"`;

        // $$`npm run release -- patch --dry --yes --additional-changelog "* ${UPDATE_MSG}"`;
    }
}

async function getLatestPythonVersion(): Promise<string> {
    const response = await fetch('https://endoflife.date/api/python.json')
    const content = await response.json();
    return content[0].cycle;
}

async function getLatestDashboardVersion(): Promise<string> {
    const response = await fetch('https://api.github.com/repos/esphome/esphome/releases')
    const content = await response.json();
    return content[0].name;
}

await run();

export {}