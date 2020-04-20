'use strict';

/*
 * Copyright (c) 2020 Payara Foundation and/or its affiliates and others.
 * All rights reserved.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0, which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the
 * Eclipse Public License v. 2.0 are satisfied: GNU General Public License,
 * version 2 with the GNU Classpath Exception, which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { WorkspaceFolder, Uri, DebugConfiguration } from "vscode";
import { Build } from './Build';
import { ChildProcess } from 'child_process';
import { JavaUtils } from '../server/tooling/utils/JavaUtils';
import { PayaraMicroProject } from '../micro/PayaraMicroProject';
import { MicroPluginReader } from './MicroPluginReader';
import { MavenPomReader } from './MavenPomReader';
import { PayaraMicroMavenPlugin } from '../micro/PayaraMicroMavenPlugin';
import { ProjectOutputWindowProvider } from './ProjectOutputWindowProvider';
import { MavenMicroPluginReader } from './MavenMicroPluginReader';
import { BuildReader } from './BuildReader';

export class Maven implements Build {

    private pomReader: BuildReader | undefined;

    private microPluginReader: MicroPluginReader | undefined;

    constructor(public workspaceFolder: WorkspaceFolder) {
        this.readBuildConfig();
    }

    public static detect(workspaceFolder: WorkspaceFolder): boolean {
        let pom = path.join(workspaceFolder.uri.fsPath, 'pom.xml');
        return fs.existsSync(pom);
    }

    public buildProject(callback: (artifact: string) => any): void {
        this.fireCommand(["clean", "install"],
            () => { },
            (code) => {
                if (code === 0 && this.workspaceFolder) {
                    let targetDir = this.getBuildDir();
                    let artifacts = fs.readdirSync(targetDir);
                    let artifact: string | null = null;
                    for (var i = 0; i < artifacts.length; i++) {
                        var filename = path.join(targetDir, artifacts[i]);
                        if (artifacts[i].endsWith('.war')
                            || artifacts[i].endsWith('.jar')
                            || artifacts[i] === this.getBuildReader().getFinalName()) {
                            artifact = filename;
                        }
                    }
                    if (artifact !== null) {
                        callback(artifact);
                    } else {
                        vscode.window.showErrorMessage(artifact + ' not found.');
                    }
                }
                if (code !== 0) {
                    console.warn(`buildProject task failed with exit code ${code}`);
                }
            },
            (error) => { 
                console.error(`Error on executing buildProject task: ${error.message}`);
             }
        );
    }

    public fireCommand(command: string[],
        dataCallback: (data: string) => any,
        exitCallback: (code: number) => any,
        errorCallback: (err: Error) => any): ChildProcess {

        let mavenHome: string | undefined = this.getDefaultHome();
        if (!mavenHome) {
            throw new Error("Maven home path not found.");
        }
        let mavenExe: string = this.getExecutableFullPath(mavenHome);
        // Maven executable should exist.
        if (!fs.existsSync(mavenExe)) {
            throw new Error("Maven executable [" + mavenExe + "] not found");
        }
        if (!this.workspaceFolder) {
            throw new Error("WorkSpace path not found.");
        }
        let pom = path.join(this.workspaceFolder.uri.fsPath, 'pom.xml');
        let process: ChildProcess = cp.spawn(mavenExe, command, { cwd: this.workspaceFolder.uri.fsPath });

        if (process.pid) {
            let outputChannel = ProjectOutputWindowProvider.getInstance().get(this.workspaceFolder);
            outputChannel.show(false);
            outputChannel.append("> " + mavenExe + ' ' + command.join(" ") + '\n');
            let logCallback = (data: string | Buffer): void => {
                outputChannel.append(data.toString());
                dataCallback(data.toString());
            };
            if (process.stdout !== null) {
                process.stdout.on('data', logCallback);
            }
            if (process.stderr !== null) {
                process.stderr.on('data', logCallback);
            }
            process.on('error', errorCallback);
            process.on('exit', exitCallback);
        }
        return process;
    }

    public getDefaultHome(): string | undefined {
        const config = vscode.workspace.getConfiguration();
        let mavenHome: string | undefined = config.get<string>('maven.home');
        if (!mavenHome) {
            mavenHome = process.env.M2_HOME;
            if (!mavenHome) {
                mavenHome = process.env.MAVEN_HOME;
            }
        }
        return mavenHome;
    }

    public getExecutableFullPath(mavenHome: string): string {
        let mavenHomeEndsWithPathSep: boolean = mavenHome.charAt(mavenHome.length - 1) === path.sep;
        // Build string.
        let mavenExecStr: string = mavenHome;
        if (!mavenHomeEndsWithPathSep) {
            mavenExecStr += path.sep;
        }
        mavenExecStr += 'bin' + path.sep + 'mvn';
        if (JavaUtils.IS_WIN) {
            if (fs.existsSync(mavenExecStr + '.bat')) {
                mavenExecStr += ".bat";
            } else if (fs.existsSync(mavenExecStr + '.cmd')) {
                mavenExecStr += ".cmd";
            }
        }
        return mavenExecStr;
    }

    public getBuildDir(): string {
        let targetDir = path.join(this.workspaceFolder.uri.fsPath, 'target');
        if (!fs.existsSync(targetDir)) {
            throw Error("no target dir found: " + targetDir);
        }
        return targetDir;
    }

    public getWorkSpaceFolder(): WorkspaceFolder {
        return this.workspaceFolder;
    }

    public getBuildReader(): BuildReader {
        if (!this.pomReader) {
            throw Error("Pom reader not initilized yet");
        }
        return this.pomReader;
    }

    public getMicroPluginReader(): MicroPluginReader {
        if (!this.microPluginReader) {
            throw Error("Pom reader not initilized yet");
        }
        return this.microPluginReader;
    }

    public readBuildConfig() {
        if (Maven.detect(this.workspaceFolder)) {
            this.microPluginReader = new MavenMicroPluginReader(this.workspaceFolder);
            this.pomReader = new MavenPomReader(this.workspaceFolder);
        }
    }

    public generateMicroProject(project: Partial<PayaraMicroProject>, callback: (projectPath: Uri) => any): ChildProcess | undefined {
        let mavenHome: string | undefined = this.getDefaultHome();
        if (!mavenHome) {
            throw new Error("Maven home path not found.");
        }
        let mavenExe: string = this.getExecutableFullPath(mavenHome);
        // Maven executable should exist.
        if (!fs.existsSync(mavenExe)) {
            throw new Error("Maven executable [" + mavenExe + "] not found");
        }
        const cmdArgs: string[] = [
            "archetype:generate",
            `-DarchetypeArtifactId=payara-micro-maven-archetype`,
            `-DarchetypeGroupId=fish.payara.maven.archetypes`,
            `-DgroupId=${project.groupId}`,
            `-DartifactId=${project.artifactId}`,
            `-Dversion=${project.version}`,
            `-Dpackage=${project.package}`,
            `-DpayaraMicroVersion=${project.payaraMicroVersion}`,
            '-DaddPayaraApi=true',
            '-DinteractiveMode=false'
        ];
        let process: ChildProcess = cp.spawn(mavenExe, cmdArgs, { cwd: project.targetFolder?.fsPath });

        if (process.pid) {
            let outputChannel = ProjectOutputWindowProvider.getInstance().get(`${project.artifactId}`);
            outputChannel.show(false);
            let logCallback = (data: string | Buffer): void => outputChannel.append(data.toString());
            if (process.stdout !== null) {
                process.stdout.on('data', logCallback);
            }
            if (process.stderr !== null) {
                process.stderr.on('data', logCallback);
            }
            process.on('error', (err: Error) => {
                console.log('error: ' + err.message);
            });
            process.on('exit', (code: number) => {
                if (code === 0 && project.targetFolder && project.artifactId) {
                    callback(vscode.Uri.file(path.join(project.targetFolder.fsPath, project.artifactId)));
                }
            });
        }
        return process;
    }

    public startPayaraMicro(
        debugConfig: DebugConfiguration | undefined,
        onData: (data: string) => any,
        onExit: (code: number) => any,
        onError: (err: Error) => any
    ): ChildProcess | undefined {

        let cmds: string[] = [];

        if (this.getMicroPluginReader().isDeployWarEnabled() === false
            && this.getMicroPluginReader().isUberJarEnabled() === false) {
            vscode.window.showWarningMessage('Please either enable the deployWar or useUberJar option in payara-micro-maven-plugin configuration to deploy the application.');
            return;
        }

        if (this.getMicroPluginReader().isUberJarEnabled()) {
            cmds = [
                "install",
                `${PayaraMicroMavenPlugin.GROUP_ID}:${PayaraMicroMavenPlugin.ARTIFACT_ID}:${PayaraMicroMavenPlugin.BUNDLE_GOAL}`,
                `${PayaraMicroMavenPlugin.GROUP_ID}:${PayaraMicroMavenPlugin.ARTIFACT_ID}:${PayaraMicroMavenPlugin.START_GOAL}`
            ];
        } else {
            cmds = [
                "resources:resources",
                "compiler:compile",
                "war:exploded",
                `${PayaraMicroMavenPlugin.GROUP_ID}:${PayaraMicroMavenPlugin.ARTIFACT_ID}:${PayaraMicroMavenPlugin.START_GOAL}`,
                "-Dexploded=true",
                "-DdeployWar=true"
            ];
        }
        if (debugConfig) {
            cmds.push(`-Ddebug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=${debugConfig.port}`);
        }
        return this.fireCommand(cmds, onData, onExit, onError);

    }

    public reloadPayaraMicro(
        onExit: (code: number) => any,
        onError: (err: Error) => any
    ): ChildProcess | undefined {
        if (this.getMicroPluginReader().isUberJarEnabled()) {
            vscode.window.showWarningMessage('The reload action not supported for UberJar artifact.');
            return;
        }
        return this.fireCommand([
            "resources:resources",
            "compiler:compile",
            "war:exploded",
            `${PayaraMicroMavenPlugin.GROUP_ID}:${PayaraMicroMavenPlugin.ARTIFACT_ID}:${PayaraMicroMavenPlugin.RELOAD_GOAL}`
        ], () => { }, onExit, onError);
    }

    public stopPayaraMicro(
        onExit: (code: number) => any,
        onError: (err: Error) => any
    ): ChildProcess | undefined {
        return this.fireCommand([
            `${PayaraMicroMavenPlugin.GROUP_ID}:${PayaraMicroMavenPlugin.ARTIFACT_ID}:${PayaraMicroMavenPlugin.STOP_GOAL}`
        ], () => { }, onExit, onError);
    }

    public bundlePayaraMicro(
        onExit: (code: number) => any,
        onError: (err: Error) => any
    ): ChildProcess | undefined {
        let cmds = [
            "install",
            `${PayaraMicroMavenPlugin.GROUP_ID}:${PayaraMicroMavenPlugin.ARTIFACT_ID}:${PayaraMicroMavenPlugin.BUNDLE_GOAL}`
        ];
        return this.fireCommand(cmds, () => { }, onExit, onError);
    }

}