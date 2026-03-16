'use strict';

/*
 * Copyright (c) 2020-2024 Payara Foundation and/or its affiliates and others.
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

import { EventEmitter } from 'events';
import * as path from 'path';
import * as vscode from 'vscode';
import { RSPController, ServerInfo, ServerState } from 'vscode-server-connector-api';
import { PayaraInstanceProvider } from '../PayaraInstanceProvider';
import { PayaraServerInstanceController } from '../PayaraServerInstanceController';
import { PayaraRspServer } from './PayaraRspServer';

/**
 * Implements the {@link RSPController} interface required by the RSP UI extension
 * (redhat.vscode-rsp-ui).  When RSP UI activates this provider it calls
 * {@link startRSP} which spins up an in-process TCP RSP server backed by the
 * existing Payara server management logic.
 */
export class PayaraRspController implements RSPController {

    private readonly rspServer: PayaraRspServer;
    private readonly emitter: EventEmitter;
    private host: string = '127.0.0.1';
    private port: number = 0;

    constructor(
        private readonly instanceProvider: PayaraInstanceProvider,
        private readonly controller: PayaraServerInstanceController,
        private readonly extensionPath: string
    ) {
        this.rspServer = new PayaraRspServer(instanceProvider, controller);
        this.emitter   = new EventEmitter();
    }

    // ------------------------------------------------------------------
    // RSPController implementation
    // ------------------------------------------------------------------

    public async startRSP(
        stdoutCallback: (data: string) => void,
        stderrCallback: (data: string) => void
    ): Promise<ServerInfo> {
        this.updateRspState(ServerState.STARTING);
        try {
            stdoutCallback('Starting Payara RSP server…\n');
            this.port = await this.rspServer.start();
            this.updateRspState(ServerState.STARTED);
            stdoutCallback(`Payara RSP server listening on ${this.host}:${this.port}\n`);
            return { host: this.host, port: this.port, spawned: false };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stderrCallback(`Failed to start Payara RSP server: ${msg}\n`);
            this.updateRspState(ServerState.STOPPED);
            return Promise.reject(`Payara RSP server failed to start: ${msg}`);
        }
    }

    public async stopRSP(): Promise<void> {
        this.updateRspState(ServerState.STOPPING);
        await this.rspServer.stop();
        this.updateRspState(ServerState.STOPPED);
    }

    public getImage(serverType: string): vscode.Uri {
        if (!serverType) { return null; }
        return vscode.Uri.file(path.join(this.extensionPath, 'resources', 'payara.png'));
    }

    public onRSPServerStateChanged(listener: (state: number) => void): void {
        this.emitter.on('rspServerStateChanged', listener);
    }

    public getHost(): string {
        return this.host;
    }

    public getPort(): number {
        return this.port;
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    private updateRspState(state: number): void {
        this.emitter.emit('rspServerStateChanged', state);
    }
}
