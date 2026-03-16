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

import * as net from 'net';
import * as rpc from 'vscode-jsonrpc';
import * as vscode from 'vscode';
import { PayaraInstanceProvider } from '../PayaraInstanceProvider';
import { PayaraServerInstance, InstanceState } from '../PayaraServerInstance';
import { PayaraServerInstanceController } from '../PayaraServerInstanceController';
import { PayaraLocalServerInstance } from '../PayaraLocalServerInstance';

/** RSP server-state constants (matches the RSP protocol spec). */
const RSP_STATE_UNKNOWN = 0;
const RSP_STATE_STARTING = 1;
const RSP_STATE_STARTED = 2;
const RSP_STATE_STOPPING = 3;
const RSP_STATE_STOPPED = 4;

/** RSP publish-state constant – fully synchronised. */
const RSP_PUBLISH_STATE_NONE = 1;
/** RSP publish-state constant – full publish required. */
const RSP_PUBLISH_STATE_FULL = 3;

/** Status severity constants. */
const STATUS_OK = 0;
const STATUS_ERROR = 4;

/** A single Payara server type exposed to RSP UI. */
const PAYARA_SERVER_TYPE = {
    id: 'payara-server',
    visibleName: 'Payara Server',
    description: 'Payara Server instance managed by Payara Tools'
};

interface DeployableReference {
    label: string;
    path: string;
    options?: { [key: string]: any };
}

interface ServerHandle {
    id: string;
    type: typeof PAYARA_SERVER_TYPE;
}

/** Minimal RSP Status object. */
function okStatus(msg: string = 'ok') {
    return { severity: STATUS_OK, plugin: 'payara-vscode', code: 0, message: msg, trace: '', ok: true };
}

function errStatus(msg: string) {
    return { severity: STATUS_ERROR, plugin: 'payara-vscode', code: 1, message: msg, trace: '', ok: false };
}

/** Maps Payara InstanceState → RSP state number. */
function toRspState(server: PayaraServerInstance): number {
    const state = server.getState();
    switch (state) {
        case InstanceState.RUNNING:    return RSP_STATE_STARTED;
        case InstanceState.LOADING:    return RSP_STATE_STARTING;
        case InstanceState.RESTARTING: return RSP_STATE_STOPPING;
        case InstanceState.STOPPED:    return RSP_STATE_STOPPED;
        default:                       return RSP_STATE_UNKNOWN;
    }
}

/** Builds a full RSP ServerState object for a Payara server. */
function buildServerState(server: PayaraServerInstance, deployables: DeployableReference[]) {
    const handle: ServerHandle = { id: server.getName(), type: PAYARA_SERVER_TYPE };
    return {
        server: handle,
        state: toRspState(server),
        publishState: RSP_PUBLISH_STATE_NONE,
        runMode: server.isDebug() ? 'debug' : 'run',
        deployableStates: deployables.map(d => ({
            server: handle,
            reference: d,
            state: RSP_STATE_STARTED,
            publishState: RSP_PUBLISH_STATE_NONE
        }))
    };
}

/**
 * In-process TCP server that implements the RSP (Runtime Server Protocol)
 * JSON-RPC protocol, backed by Payara's existing server management.
 *
 * RSP UI (redhat.vscode-rsp-ui) connects to this server and can then use
 * "Run on Server" / "Debug on Server" to deploy to registered Payara instances.
 */
export class PayaraRspServer {

    private tcpServer: net.Server;
    private port: number = 0;
    /** Active JSON-RPC connections (one per RSP UI connection). */
    private connections: rpc.MessageConnection[] = [];
    /**
     * Deployable references queued per server handle id.
     * Populated by addDeployable; consumed by publish.
     */
    private pendingDeployables: Map<string, DeployableReference[]> = new Map();

    constructor(
        private readonly instanceProvider: PayaraInstanceProvider,
        private readonly controller: PayaraServerInstanceController
    ) { }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /** Starts the TCP listener. Resolves with the port number. */
    public start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.tcpServer = net.createServer(socket => this.handleConnection(socket));
            this.tcpServer.on('error', reject);
            this.tcpServer.listen(0, '127.0.0.1', () => {
                this.port = (this.tcpServer.address() as net.AddressInfo).port;
                resolve(this.port);
            });
        });
    }

    /** Stops the TCP listener and disposes all active connections. */
    public stop(): Promise<void> {
        return new Promise(resolve => {
            for (const conn of this.connections) {
                try { conn.dispose(); } catch (_) { /* ignore */ }
            }
            this.connections = [];
            if (this.tcpServer) {
                this.tcpServer.close(() => resolve());
            } else {
                resolve();
            }
        });
    }

    public getPort(): number {
        return this.port;
    }

    // ------------------------------------------------------------------
    // Connection handling
    // ------------------------------------------------------------------

    private handleConnection(socket: net.Socket): void {
        const reader = new rpc.StreamMessageReader(socket);
        const writer = new rpc.StreamMessageWriter(socket);
        const conn: rpc.MessageConnection = rpc.createMessageConnection(reader, writer);
        this.connections.push(conn);

        socket.on('close', () => {
            const idx = this.connections.indexOf(conn);
            if (idx !== -1) { this.connections.splice(idx, 1); }
        });

        this.registerHandlers(conn);
        conn.listen();

        // Announce all currently known servers to this new client.
        this.instanceProvider.getServers().forEach(server => {
            const handle: ServerHandle = { id: server.getName(), type: PAYARA_SERVER_TYPE };
            conn.sendNotification('client/serverAdded', handle);
        });
    }

    // ------------------------------------------------------------------
    // Request / notification handlers
    // ------------------------------------------------------------------

    private registerHandlers(conn: rpc.MessageConnection): void {

        // Handshake ----------------------------------------------------
        conn.onRequest('server/registerClientCapabilities', (_params: any) => {
            return {
                serverCapabilities: { 'protocol.version': '0.21.0' },
                clientRegistrationStatus: okStatus('Client registered')
            };
        });

        // Discovery paths (Payara does not use these) ------------------
        conn.onRequest('server/getDiscoveryPaths', () => [] as any[]);
        conn.onRequest('server/addDiscoveryPath', () => okStatus());
        conn.onRequest('server/removeDiscoveryPath', () => okStatus());
        conn.onRequest('server/findServerBeans', () => [] as any[]);

        // Server types and handles -------------------------------------
        conn.onRequest('server/getServerTypes', () => [PAYARA_SERVER_TYPE]);

        conn.onRequest('server/getServerHandles', () =>
            this.instanceProvider.getServers().map(s => ({
                id: s.getName(),
                type: PAYARA_SERVER_TYPE
            }))
        );

        conn.onRequest('server/getServerState', (handle: ServerHandle) => {
            const server = this.instanceProvider.getServerByName(handle.id);
            if (!server) { return Promise.reject(`Server ${handle.id} not found`); }
            const deployables = this.pendingDeployables.get(handle.id) || [];
            return buildServerState(server, deployables);
        });

        // Server type attributes (none required by Payara Tools) -------
        conn.onRequest('server/getRequiredAttributes', () => ({ attributes: {} }));
        conn.onRequest('server/getOptionalAttributes', () => ({ attributes: {} }));
        conn.onRequest('server/getRequiredLaunchAttributes', () => ({ attributes: {} }));
        conn.onRequest('server/getOptionalLaunchAttributes', () => ({ attributes: {} }));

        // Launch modes -------------------------------------------------
        conn.onRequest('server/getLaunchModes', (_type: any) => [
            { mode: 'run',   desc: 'Run mode'   },
            { mode: 'debug', desc: 'Debug mode' }
        ]);

        // Deployables --------------------------------------------------
        conn.onRequest('server/getDeployables', (handle: ServerHandle) => {
            const deployables = this.pendingDeployables.get(handle.id) || [];
            const server = this.instanceProvider.getServerByName(handle.id);
            if (!server) {
                return { states: [], status: errStatus(`Server ${handle.id} not found`) };
            }
            return {
                states: deployables.map(d => ({
                    server: { id: server.getName(), type: PAYARA_SERVER_TYPE },
                    reference: d,
                    state: RSP_STATE_STARTED,
                    publishState: RSP_PUBLISH_STATE_NONE
                })),
                status: okStatus()
            };
        });

        conn.onRequest('server/listDeploymentOptions', (_handle: any) =>
            ({ attributes: {}, status: okStatus() })
        );

        conn.onRequest('server/addDeployable', (params: { server: ServerHandle; deployableReference: DeployableReference }) => {
            const { server: handle, deployableReference: ref } = params;
            if (!this.pendingDeployables.has(handle.id)) {
                this.pendingDeployables.set(handle.id, []);
            }
            const list = this.pendingDeployables.get(handle.id);
            // Avoid duplicates by path
            if (!list.some(d => d.path === ref.path)) {
                list.push(ref);
            }
            // Notify RSP UI that publish is now needed
            const server = this.instanceProvider.getServerByName(handle.id);
            if (server) {
                this.notifyStateChanged(server, RSP_PUBLISH_STATE_FULL);
            }
            return okStatus();
        });

        conn.onRequest('server/removeDeployable', (params: { server: ServerHandle; deployableReference: DeployableReference }) => {
            const { server: handle, deployableReference: ref } = params;
            const list = this.pendingDeployables.get(handle.id) || [];
            this.pendingDeployables.set(handle.id, list.filter(d => d.path !== ref.path));
            return okStatus();
        });

        // Publish (deploy) ---------------------------------------------
        conn.onRequest('server/publish', (params: { server: ServerHandle; kind: number }) =>
            this.publishServer(params.server, false)
        );

        conn.onRequest('server/publishAsync', (params: { server: ServerHandle; kind: number }) =>
            this.publishServer(params.server, false)
        );

        // Start / stop -------------------------------------------------
        conn.onRequest('server/startServerAsync', (params: { mode: string; params: { id: string } }) =>
            this.startServer(params.params.id, params.mode === 'debug')
        );

        conn.onRequest('server/stopServerAsync', (params: { id: string; force: boolean }) =>
            this.stopServer(params.id)
        );

        // Misc ----------------------------------------------------------
        conn.onRequest('server/listServerActions', () =>
            ({ workflows: [] as any[], status: okStatus() })
        );
        conn.onRequest('server/getJobs', () => [] as any[]);
        conn.onRequest('server/listDownloadableRuntimes', () => ({ runtimes: [] as any[] }));

        // Shutdown / disconnect -----------------------------------------
        conn.onNotification('server/shutdown', () => conn.dispose());
        conn.onNotification('server/disconnectClient', () => conn.dispose());
    }

    // ------------------------------------------------------------------
    // Business logic
    // ------------------------------------------------------------------

    /** Deploys all pending deployables for the given server handle. */
    private async publishServer(handle: ServerHandle, debug: boolean): Promise<any> {
        const server = this.instanceProvider.getServerByName(handle.id);
        if (!server) {
            return errStatus(`Server ${handle.id} not found`);
        }
        const deployables = this.pendingDeployables.get(handle.id) || [];
        if (deployables.length === 0) {
            return okStatus('Nothing to deploy');
        }
        for (const ref of deployables) {
            const uri = vscode.Uri.file(ref.path);
            this.controller.deployApp(uri, debug, false, server);
        }
        this.notifyStateChanged(server, RSP_PUBLISH_STATE_NONE);
        return okStatus();
    }

    /** Starts the Payara server identified by handle ID. */
    private async startServer(serverId: string, debug: boolean): Promise<any> {
        const server = this.instanceProvider.getServerByName(serverId);
        if (!server) {
            return { status: errStatus(`Server ${serverId} not found`), details: null };
        }
        if (!(server instanceof PayaraLocalServerInstance)) {
            // Remote servers are not started via RSP
            return { status: errStatus('Cannot start a remote Payara Server via RSP'), details: null };
        }
        if (server.isStarted()) {
            return { status: okStatus('Server already started'), details: null };
        }
        this.notifyRspState(server, RSP_STATE_STARTING);
        return new Promise(resolve => {
            this.controller.startServer(server, debug, '', (success: boolean) => {
                this.notifyRspState(server, success ? RSP_STATE_STARTED : RSP_STATE_STOPPED);
                resolve({
                    status: success ? okStatus() : errStatus(`Failed to start ${serverId}`),
                    details: null
                });
            });
        });
    }

    /** Stops the Payara server identified by handle ID. */
    private async stopServer(serverId: string): Promise<any> {
        const server = this.instanceProvider.getServerByName(serverId);
        if (!server) {
            return errStatus(`Server ${serverId} not found`);
        }
        if (!(server instanceof PayaraLocalServerInstance)) {
            return errStatus('Cannot stop a remote Payara Server via RSP');
        }
        if (server.isStopped()) {
            return okStatus('Server already stopped');
        }
        this.notifyRspState(server, RSP_STATE_STOPPING);
        this.controller.stopServer(server);
        this.notifyRspState(server, RSP_STATE_STOPPED);
        return okStatus();
    }

    // ------------------------------------------------------------------
    // Push notifications
    // ------------------------------------------------------------------

    /** Broadcasts a serverStateChanged notification to all clients. */
    private notifyRspState(server: PayaraServerInstance, rspState: number): void {
        const deployables = this.pendingDeployables.get(server.getName()) || [];
        const payload = {
            server: { id: server.getName(), type: PAYARA_SERVER_TYPE },
            state: rspState,
            publishState: RSP_PUBLISH_STATE_NONE,
            runMode: server.isDebug() ? 'debug' : 'run',
            deployableStates: deployables.map(d => ({
                server: { id: server.getName(), type: PAYARA_SERVER_TYPE },
                reference: d,
                state: RSP_STATE_STARTED,
                publishState: RSP_PUBLISH_STATE_NONE
            }))
        };
        this.broadcast('client/serverStateChanged', payload);
    }

    /** Broadcasts a serverStateChanged notification using the current Payara state. */
    private notifyStateChanged(server: PayaraServerInstance, publishState: number): void {
        const deployables = this.pendingDeployables.get(server.getName()) || [];
        const payload = {
            server: { id: server.getName(), type: PAYARA_SERVER_TYPE },
            state: toRspState(server),
            publishState,
            runMode: server.isDebug() ? 'debug' : 'run',
            deployableStates: deployables.map(d => ({
                server: { id: server.getName(), type: PAYARA_SERVER_TYPE },
                reference: d,
                state: RSP_STATE_STARTED,
                publishState: RSP_PUBLISH_STATE_NONE
            }))
        };
        this.broadcast('client/serverStateChanged', payload);
    }

    /** Sends a notification to all active client connections. */
    private broadcast(method: string, params: any): void {
        for (const conn of this.connections) {
            try { conn.sendNotification(method, params); } catch (_) { /* ignore */ }
        }
    }
}
