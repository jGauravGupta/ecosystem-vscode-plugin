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
import * as _ from "lodash";
import * as ui from "../../../UI";
import { Maven } from '../project/Maven';
import { OpenDialogOptions, Uri, WorkspaceFolder } from 'vscode';
import { PayaraMicroProject } from './PayaraMicroProject';
import { PayaraMicroInstanceController } from './PayaraMicroInstanceController';

const TITLE = 'Generate a Payara Micro project';
const TOTAL_STEP = 7;
const DEFAULT_VERSION: string = '1.0.0-SNAPSHOT';
const DEFAULT_ARTIFACT_ID: string = 'payara-micro-sample';
const DEFAULT_GROUP_ID: string = 'fish.payara.micro.sample';
const PAYARA_MICRO_VERSIONS = [
    '5.201',
    '5.194', '5.193.1', '5.192', '5.191',
    '5.184', '5.183', '5.182', '5.181'
];

export class PayaraMicroProjectGenerator {

    constructor(private instanceController: PayaraMicroInstanceController) {
    }

    public createProject(): void {
        ui.MultiStepInput.run(
            input => this.groupId(input,
                {},
                project => {
                    if (project.targetFolder && project.artifactId) {
                        let workspaceFolder: WorkspaceFolder = {
                            uri: vscode.Uri.file(path.join(project.targetFolder.fsPath, project.artifactId)),
                            name: project.artifactId,
                            index: 0
                        };
                        new Maven(workspaceFolder)
                            .generateMicroProject(project, async (projectPath) => {
                                const CURRENT_WORKSPACE = "Add to current workspace";
                                const NEW_WORKSPACE = "Open in new window";
                                const choice = await vscode.window.showInformationMessage(
                                    "Payara Micro project generated successfully. Would you like to:",
                                    ...[CURRENT_WORKSPACE, NEW_WORKSPACE,]
                                );
                                if (choice === CURRENT_WORKSPACE) {
                                    vscode.workspace.updateWorkspaceFolders(0, 0, { uri: projectPath });
                                    this.instanceController.refreshMicroList();
                                } else if (choice === NEW_WORKSPACE) {
                                    await vscode.commands.executeCommand("vscode.openFolder", projectPath, true);
                                }
                            });
                    }
                })
        );
    }

    private async groupId(input: ui.MultiStepInput, project: Partial<PayaraMicroProject>, callback: (n: Partial<PayaraMicroProject>) => any) {
        let groupId = await input.showInputBox({
            title: TITLE,
            step: 1,
            totalSteps: TOTAL_STEP,
            value: project.groupId || DEFAULT_GROUP_ID,
            prompt: 'Enter a Group Id for your project',
            placeHolder: 'Project Group Id',
            validate: value => this.validate('Group Id', value),
            shouldResume: this.shouldResume
        });

        project.groupId = groupId ? groupId : DEFAULT_GROUP_ID;
        return (input: ui.MultiStepInput) => this.artifactId(input, project, callback);
    }

    private async artifactId(input: ui.MultiStepInput, project: Partial<PayaraMicroProject>, callback: (n: Partial<PayaraMicroProject>) => any) {
        let artifactId = await input.showInputBox({
            title: TITLE,
            step: 2,
            totalSteps: TOTAL_STEP,
            value: project.artifactId || DEFAULT_ARTIFACT_ID,
            prompt: 'Enter a Artifact Id for your project',
            placeHolder: 'Project Artifact Id',
            validate: value => this.validate('Artifact Id', value),
            shouldResume: this.shouldResume
        });

        project.artifactId = artifactId ? artifactId : DEFAULT_ARTIFACT_ID;
        return (input: ui.MultiStepInput) => this.version(input, project, callback);
    }

    private async version(input: ui.MultiStepInput, project: Partial<PayaraMicroProject>, callback: (n: Partial<PayaraMicroProject>) => any) {
        let version = await input.showInputBox({
            title: TITLE,
            step: 3,
            totalSteps: TOTAL_STEP,
            value: project.version || DEFAULT_VERSION,
            prompt: 'Enter the version for your project',
            placeHolder: 'Project Version',
            validate: value => this.validate('Project version', value),
            shouldResume: this.shouldResume
        });

        project.version = version ? version : DEFAULT_VERSION;
        return (input: ui.MultiStepInput) => this.contextRoot(input, project, callback);
    }

    private async contextRoot(input: ui.MultiStepInput, project: Partial<PayaraMicroProject>, callback: (n: Partial<PayaraMicroProject>) => any) {
        let contextRoot = await input.showInputBox({
            title: TITLE,
            step: 4,
            totalSteps: TOTAL_STEP,
            value: '/',
            prompt: 'Enter the context root of your application',
            placeHolder: 'Context root',
            validate: value => this.validate('Context Root', value),
            shouldResume: this.shouldResume
        });

        project.contextRoot = contextRoot ? contextRoot : '/';
        return (input: ui.MultiStepInput) => this.packageName(input, project, callback);
    }

    private async packageName(input: ui.MultiStepInput, project: Partial<PayaraMicroProject>, callback: (n: Partial<PayaraMicroProject>) => any) {
        let packageName = await input.showInputBox({
            title: TITLE,
            step: 5,
            totalSteps: TOTAL_STEP,
            value: project.package || project.groupId || DEFAULT_GROUP_ID,
            prompt: 'Enter the package name',
            placeHolder: 'Package name',
            validate: value => this.validate('Package name', value),
            shouldResume: this.shouldResume
        });

        project.package = packageName ? packageName : DEFAULT_GROUP_ID;
        return (input: ui.MultiStepInput) => this.payaraMicroVersion(input, project, callback);
    }

    private async payaraMicroVersion(input: ui.MultiStepInput, project: Partial<PayaraMicroProject>, callback: (n: Partial<PayaraMicroProject>) => any) {
        let versions = PAYARA_MICRO_VERSIONS.map(label => ({ label }));
        const pick = await input.showQuickPick({
            title: TITLE,
            step: 6,
            totalSteps: TOTAL_STEP,
            placeholder: 'Select a Payara Micro version.',
            items: versions,
            activeItem: versions[0],
            shouldResume: this.shouldResume
        });
        project.payaraMicroVersion = pick.label;
        return (input: ui.MultiStepInput) => this.selectTargetFolder(input, project, callback);
    }

    private async selectTargetFolder(input: ui.MultiStepInput, project: Partial<PayaraMicroProject>, callback: (n: Partial<PayaraMicroProject>) => any) {
        let dialogOptions: OpenDialogOptions = ({
            defaultUri: vscode.workspace.rootPath ? vscode.Uri.file(vscode.workspace.rootPath) : undefined,
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Destination Folder'
        });
        let fileUris = await vscode.window.showOpenDialog(dialogOptions);
        if (!fileUris) {
            return;
        }
        if (_.isEmpty(fileUris) || !fileUris[0].fsPath) {
            vscode.window.showErrorMessage("Selected path is invalid.");
        }
        project.targetFolder = fileUris[0];
        callback(project);
    }



    private async validate(type: string, value: string): Promise<string | undefined> {
        if (_.isEmpty(value)) {
            return `${type} cannot be empty`;
        } else if (/\s/.test(value)) {
            return `${type} cannot contain spaces`;
        }
        return undefined;
    }

    private async shouldResume(): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
        });
    }


}

