/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';
import { RunOnceScheduler } from 'vs/base/common/async';
import { VSBuffer } from 'vs/base/common/buffer';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { IRemoteConsoleLog } from 'vs/base/common/console';
import { isPromiseCanceledError, onUnexpectedError, setUnexpectedErrorHandler } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { IDisposable } from 'vs/base/common/lifecycle';
import { FileAccess, Schemas } from 'vs/base/common/network';
import { dirname, join } from 'vs/base/common/path';
import * as platform from 'vs/base/common/platform';
import Severity from 'vs/base/common/severity';
import { ReadableStreamEventPayload } from 'vs/base/common/stream';
import { URI } from 'vs/base/common/uri';
import { IRawURITransformer, transformIncomingURIs, transformOutgoingURIs, URITransformer } from 'vs/base/common/uriIpc';
import { generateUuid } from 'vs/base/common/uuid';
import { ClientConnectionEvent, IPCServer, IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { PersistentProtocol, ProtocolConstants } from 'vs/base/parts/ipc/common/ipc.net';
import { NodeSocket, WebSocketNodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ConfigurationService } from 'vs/platform/configuration/common/configurationService';
import { ExtensionHostDebugBroadcastChannel } from 'vs/platform/debug/common/extensionHostDebugIpc';
import { IDownloadService } from 'vs/platform/download/common/download';
import { DownloadService } from 'vs/platform/download/common/downloadService';
import { NativeParsedArgs } from 'vs/platform/environment/common/argv';
import { IEnvironmentService, INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { OptionDescriptions, OPTIONS, parseArgs } from 'vs/platform/environment/node/argv';
import { NativeEnvironmentService } from 'vs/platform/environment/node/environmentService';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/common/extensionGalleryService';
import { IExtensionGalleryService, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { ExtensionIdentifier, IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { FileService } from 'vs/platform/files/common/fileService';
import { DiskFileSystemProvider } from 'vs/platform/files/node/diskFileSystemProvider';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { createDecorator, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { BufferLogService } from 'vs/platform/log/common/bufferLog';
import { ConsoleMainLogger, getLogLevel, ILogService, MultiplexLogService } from 'vs/platform/log/common/log';
import { LogLevelChannel } from 'vs/platform/log/common/logIpc';
import { SpdLogLogger } from 'vs/platform/log/node/spdlogLog';
import product from 'vs/platform/product/common/product';
import { IProductService } from 'vs/platform/product/common/productService';
import { ConnectionType, ErrorMessage, HandshakeMessage, IRemoteExtensionHostStartParams, OKMessage, SignRequest } from 'vs/platform/remote/common/remoteAgentConnection';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { IRequestService } from 'vs/platform/request/common/request';
import { RequestChannel } from 'vs/platform/request/common/requestIpc';
import { RequestService } from 'vs/platform/request/node/requestService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { IFileChangeDto } from 'vs/workbench/api/common/extHost.protocol';
import { IExtHostReadyMessage, IExtHostSocketMessage } from 'vs/workbench/services/extensions/common/extensionHostProtocol';
import { Logger } from 'vs/workbench/services/extensions/common/extensionPoints';
import { ExtensionScanner, ExtensionScannerInput, IExtensionReference } from 'vs/workbench/services/extensions/node/extensionPoints';
import { IGetEnvironmentDataArguments, IRemoteAgentEnvironmentDTO, IScanExtensionsArguments, IScanSingleExtensionArguments } from 'vs/workbench/services/remote/common/remoteAgentEnvironmentChannel';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from 'vs/workbench/services/remote/common/remoteAgentFileSystemChannel';
import { RemoteExtensionLogFileName } from 'vs/workbench/services/remote/common/remoteAgentService';

export type IRawURITransformerFactory = (remoteAuthority: string) => IRawURITransformer;
export const IRawURITransformerFactory = createDecorator<IRawURITransformerFactory>('rawURITransformerFactory');

const APP_ROOT = dirname(FileAccess.asFileUri('', require).fsPath);
const uriTransformerPath = path.join(APP_ROOT, 'out/serverUriTransformer');
const rawURITransformerFactory: IRawURITransformerFactory = <any>require.__$__nodeRequire(uriTransformerPath);

const WEB_MAIN = path.join(APP_ROOT, 'out', 'vs', 'server', 'browser', 'workbench', 'workbench.html');
const WEB_MAIN_DEV = path.join(APP_ROOT, 'out', 'vs', 'server', 'browser', 'workbench', 'workbench-dev.html');

function registerErrorHandler(logService: ILogService): void {
	setUnexpectedErrorHandler(e => logService.error(e));
	// Print a console message when rejection isn't handled within N seconds. For details:
	// see https://nodejs.org/api/process.html#process_event_unhandledrejection
	// and https://nodejs.org/api/process.html#process_event_rejectionhandled
	const unhandledPromises: Promise<any>[] = [];
	process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
		unhandledPromises.push(promise);
		setTimeout(() => {
			const idx = unhandledPromises.indexOf(promise);
			if (idx >= 0) {
				promise.catch(e => {
					unhandledPromises.splice(idx, 1);
					if (!isPromiseCanceledError(e)) {
						logService.warn(`rejected promise not handled within 1 second: ${e}`);
						if (e && e.stack) {
							logService.warn(`stack trace: ${e.stack}`);
						}
						onUnexpectedError(reason);
					}
				});
			}
		}, 1000);
	});

	process.on('rejectionHandled', (promise: Promise<any>) => {
		const idx = unhandledPromises.indexOf(promise);
		if (idx >= 0) {
			unhandledPromises.splice(idx, 1);
		}
	});

	// Print a console message when an exception isn't handled.
	process.on('uncaughtException', function (err: Error) {
		onUnexpectedError(err);
	});
}

interface ManagementProtocol {
	protocol: PersistentProtocol
	graceTimeReconnection: RunOnceScheduler
	shortGraceTimeReconnection: RunOnceScheduler
}

interface Client {
	management?: ManagementProtocol
	extensionHost?: cp.ChildProcess
}

function safeDisposeProtocolAndSocket(protocol: PersistentProtocol): void {
	try {
		protocol.acceptDisconnect();
		const socket = protocol.getSocket();
		protocol.dispose();
		socket.dispose();
	} catch (err) {
		onUnexpectedError(err);
	}
}

// TODO is it enough?
const textMimeType = new Map([
	['.html', 'text/html'],
	['.js', 'text/javascript'],
	['.json', 'application/json'],
	['.css', 'text/css'],
	['.svg', 'image/svg+xml']
]);

// TODO is it enough?
const mapExtToMediaMimes = new Map([
	['.bmp', 'image/bmp'],
	['.gif', 'image/gif'],
	['.ico', 'image/x-icon'],
	['.jpe', 'image/jpg'],
	['.jpeg', 'image/jpg'],
	['.jpg', 'image/jpg'],
	['.png', 'image/png'],
	['.tga', 'image/x-tga'],
	['.tif', 'image/tiff'],
	['.tiff', 'image/tiff'],
	['.woff', 'application/font-woff']
]);

function getMediaMime(forPath: string): string | undefined {
	const ext = path.extname(forPath);
	return mapExtToMediaMimes.get(ext.toLowerCase());
}

function serveError(req: http.IncomingMessage, res: http.ServerResponse, errorCode: number, errorMessage: string): void {
	res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
	res.end(errorMessage);
}

function getFirstQueryValue(parsedUrl: url.UrlWithParsedQuery, key: string): string | undefined {
	const result = parsedUrl.query[key];
	return Array.isArray(result) ? result[0] : result;
}

function getFirstQueryValues(parsedUrl: url.UrlWithParsedQuery, ignoreKeys?: string[]): Map<string, string> {
	const queryValues: Map<string, string> = new Map();

	for (const key in parsedUrl.query) {
		if (ignoreKeys && ignoreKeys.indexOf(key) >= 0) {
			continue;
		}

		const value = getFirstQueryValue(parsedUrl, key);
		if (typeof value === 'string') {
			queryValues.set(key, value);
		}
	}

	return queryValues;
}

async function serveFile(logService: ILogService, req: http.IncomingMessage, res: http.ServerResponse, filePath: string, responseHeaders: http.OutgoingHttpHeaders = {}) {
	try {

		// Sanity checks
		filePath = path.normalize(filePath); // ensure no "." and ".."

		const stat = await fs.promises.stat(filePath);

		// Check if file modified since
		const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304);
			return res.end();
		}

		// Headers
		responseHeaders['Content-Type'] = textMimeType.get(path.extname(filePath)) || getMediaMime(filePath) || 'text/plain';
		responseHeaders['Etag'] = etag;

		res.writeHead(200, responseHeaders);

		// Data
		fs.createReadStream(filePath).pipe(res);
	} catch (error) {
		logService.error(error);
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('Not found');
	}
}

async function handleRoot(req: http.IncomingMessage, resp: http.ServerResponse, entryPointPath: string, environmentService: INativeEnvironmentService) {
	if (!req.headers.host) {
		return serveError(req, resp, 400, 'Bad request.');
	}

	const workbenchConfig = {
		developmentOptions: {
			enableSmokeTestDriver: environmentService.driverHandle === 'web' ? true : undefined
		}
	};

	const escapeQuote = (str: string) => str.replace(/"/g, '&quot;');
	const entryPointContent = (await fs.promises.readFile(entryPointPath))
		.toString()
		.replace('{{WORKBENCH_WEB_CONFIGURATION}}', escapeQuote(JSON.stringify(workbenchConfig)));

	resp.writeHead(200, {
		'Content-Type': 'text/html'
	});
	return resp.end(entryPointContent);
}

const mapCallbackUriToRequestId = new Map<string, string>();
async function handleCallback(logService: ILogService, req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery) {
	const wellKnownKeys = ['vscode-requestId', 'vscode-scheme', 'vscode-authority', 'vscode-path', 'vscode-query', 'vscode-fragment'];
	const [requestId, vscodeScheme, vscodeAuthority, vscodePath, vscodeQuery, vscodeFragment] = wellKnownKeys.map(key => {
		const value = getFirstQueryValue(parsedUrl, key);
		if (value) {
			return decodeURIComponent(value);
		}

		return value;
	});

	if (!requestId) {
		res.writeHead(400, { 'Content-Type': 'text/plain' });
		return res.end(`Bad request.`);
	}

	// merge over additional query values that we got
	let query = vscodeQuery;
	let index = 0;
	getFirstQueryValues(parsedUrl, wellKnownKeys).forEach((value, key) => {
		if (!query) {
			query = '';
		}

		const prefix = (index++ === 0) ? '' : '&';
		query += `${prefix}${key}=${value}`;
	});

	// add to map of known callbacks
	mapCallbackUriToRequestId.set(requestId, JSON.stringify({ scheme: vscodeScheme || product.urlProtocol, authority: vscodeAuthority, path: vscodePath, query, fragment: vscodeFragment }));
	return serveFile(logService, req, res, FileAccess.asFileUri('vs/code/browser/workbench/callback.html', require).fsPath, { 'Content-Type': 'text/html' });
}

async function handleFetchCallback(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery) {
	const requestId = getFirstQueryValue(parsedUrl, 'vscode-requestId');
	if (!requestId) {
		res.writeHead(400, { 'Content-Type': 'text/plain' });
		return res.end(`Bad request.`);
	}

	const knownCallbackUri = mapCallbackUriToRequestId.get(requestId);
	if (knownCallbackUri) {
		mapCallbackUriToRequestId.delete(requestId);
	}

	res.writeHead(200, { 'Content-Type': 'text/json' });
	return res.end(knownCallbackUri);
}


interface ServerParsedArgs extends NativeParsedArgs {
	port?: string
	host?: string
}
const SERVER_OPTIONS: OptionDescriptions<ServerParsedArgs> = {
	...OPTIONS,
	port: { type: 'string' },
	host: { type: 'string' }
};

export interface IStartServerResult {
	installingInitialExtensions?: Promise<void>
}

export interface IServerOptions {
	port?: number;
	main?: string
	mainDev?: string
	skipExtensions?: Set<string>
	configure?(services: ServiceCollection, channelServer: IPCServer<RemoteAgentConnectionContext>): void
	start?(accessor: ServicesAccessor, channelServer: IPCServer<RemoteAgentConnectionContext>): IStartServerResult | void

	configureExtensionHostForkOptions?(opts: cp.ForkOptions, accessor: ServicesAccessor, channelServer: IPCServer<RemoteAgentConnectionContext>): void;
	configureExtensionHostProcess?(extensionHost: cp.ChildProcess, accessor: ServicesAccessor, channelServer: IPCServer<RemoteAgentConnectionContext>): IDisposable;

	handleRequest?(pathname: string | null, req: http.IncomingMessage, res: http.ServerResponse, accessor: ServicesAccessor, channelServer: IPCServer<RemoteAgentConnectionContext>): Promise<boolean>;
}

export async function main(options: IServerOptions): Promise<void> {
	const connectionToken = generateUuid();

	const parsedArgs = parseArgs(process.argv, SERVER_OPTIONS);
	parsedArgs['user-data-dir'] = URI.file(path.join(os.homedir(), product.dataFolderName)).fsPath;
	const productService = { _serviceBrand: undefined, ...product };
	const environmentService = new NativeEnvironmentService(parsedArgs, productService);

	const devMode = !environmentService.isBuilt;

	// see src/vs/code/electron-main/main.ts#142
	const bufferLogService = new BufferLogService();
	const logService = new MultiplexLogService([new ConsoleMainLogger(getLogLevel(environmentService)), bufferLogService]);
	registerErrorHandler(logService);

	// see src/vs/code/electron-main/main.ts#204
	await Promise.all<string | undefined>([
		environmentService.extensionsPath,
		environmentService.logsPath,
		environmentService.globalStorageHome.fsPath,
		environmentService.workspaceStorageHome.fsPath
	].map(path => path ? fs.promises.mkdir(path, { recursive: true }) : undefined));

	const onDidClientConnectEmitter = new Emitter<ClientConnectionEvent>();
	const channelServer = new IPCServer<RemoteAgentConnectionContext>(onDidClientConnectEmitter.event);
	channelServer.registerChannel('logger', new LogLevelChannel(logService));
	channelServer.registerChannel(ExtensionHostDebugBroadcastChannel.ChannelName, new ExtensionHostDebugBroadcastChannel());

	const fileService = new FileService(logService);
	const diskFileSystemProvider = new DiskFileSystemProvider(logService);
	fileService.registerProvider(Schemas.file, diskFileSystemProvider);
	const rootPath = FileAccess.asFileUri('', require).fsPath;

	const extraDevSystemExtensionsRoot = path.normalize(path.join(rootPath, '..', '.build', 'builtInExtensions'));
	const logger = new Logger((severity, source, message) => {
		const msg = devMode && source ? `[${source}]: ${message}` : message;
		if (severity === Severity.Error) {
			logService.error(msg);
		} else if (severity === Severity.Warning) {
			logService.warn(msg);
		} else {
			logService.info(msg);
		}
	});
	// see used APIs in vs/workbench/services/remote/common/remoteAgentEnvironmentChannel.ts
	class RemoteExtensionsEnvironment implements IServerChannel<RemoteAgentConnectionContext> {
		protected extensionHostLogFileSeq = 1;
		async call(ctx: RemoteAgentConnectionContext, command: string, arg?: any, cancellationToken?: CancellationToken | undefined): Promise<any> {
			if (command === 'getEnvironmentData') {
				const args: IGetEnvironmentDataArguments = arg;
				const uriTranformer = new URITransformer(rawURITransformerFactory(args.remoteAuthority));
				return transformOutgoingURIs({
					pid: process.pid,
					connectionToken,
					appRoot: URI.file(environmentService.appRoot),
					settingsPath: environmentService.machineSettingsResource,
					logsPath: URI.file(environmentService.logsPath),
					extensionsPath: URI.file(environmentService.extensionsPath),
					extensionHostLogsPath: URI.file(path.join(environmentService.logsPath, `extension_host_${this.extensionHostLogFileSeq++}`)),
					globalStorageHome: environmentService.globalStorageHome,
					workspaceStorageHome: environmentService.workspaceStorageHome,
					userHome: environmentService.userHome,
					os: platform.OS,
					arch: process.arch,
					marks: [],
					useHostProxy: false
				} as IRemoteAgentEnvironmentDTO, uriTranformer);
			}
			if (command === 'scanSingleExtension') {
				let args: IScanSingleExtensionArguments = arg;
				const uriTranformer = new URITransformer(rawURITransformerFactory(args.remoteAuthority));
				args = transformIncomingURIs(args, uriTranformer);
				// see scanSingleExtension in src/vs/workbench/services/extensions/electron-browser/cachedExtensionScanner.ts
				// TODO: read built nls file
				const translations = {};
				const input = new ExtensionScannerInput(product.version, product.date, product.commit, args.language, devMode, URI.revive(args.extensionLocation).fsPath, args.isBuiltin, false, translations);
				const extension = await ExtensionScanner.scanSingleExtension(input, logService);
				if (!extension) {
					return undefined;
				}
				return transformOutgoingURIs(extension, uriTranformer);
			}
			if (command === 'scanExtensions') {
				let args: IScanExtensionsArguments = arg;
				const uriTranformer = new URITransformer(rawURITransformerFactory(args.remoteAuthority));
				args = transformIncomingURIs(args, uriTranformer);
				// see _scanInstalledExtensions in src/vs/workbench/services/extensions/electron-browser/cachedExtensionScanner.ts
				// TODO: read built nls file
				const translations = {};
				let pendingSystem = ExtensionScanner.scanExtensions(new ExtensionScannerInput(product.version, product.date, product.commit, args.language, devMode, environmentService.builtinExtensionsPath, true, false, translations), logger);
				const builtInExtensions = product.builtInExtensions;
				if (devMode && builtInExtensions && builtInExtensions.length) {
					pendingSystem = ExtensionScanner.mergeBuiltinExtensions(pendingSystem, ExtensionScanner.scanExtensions(new ExtensionScannerInput(product.version, product.date, product.commit, args.language, devMode, extraDevSystemExtensionsRoot, true, false, translations), logger, {
						resolveExtensions: () => {
							const result: IExtensionReference[] = [];
							for (const extension of builtInExtensions) {
								result.push({ name: extension.name, path: path.join(extraDevSystemExtensionsRoot, extension.name) });
							}
							return Promise.resolve(result);
						}
					}));
				}
				const pendingUser = extensionsInstalled.then(() => ExtensionScanner.scanExtensions(new ExtensionScannerInput(product.version, product.date, product.commit, args.language, devMode, environmentService.extensionsPath, false, false, translations), logger));
				let pendingDev: Promise<IExtensionDescription[]>[] = [];
				if (args.extensionDevelopmentPath) {
					pendingDev = args.extensionDevelopmentPath.map(devPath => ExtensionScanner.scanOneOrMultipleExtensions(new ExtensionScannerInput(product.version, product.date, product.commit, args.language, devMode, URI.revive(devPath).fsPath, false, true, translations), logger));
				}
				const result: IExtensionDescription[] = [];
				const skipExtensions = new Set<string>([...args.skipExtensions.map(ExtensionIdentifier.toKey), ...(options?.skipExtensions || [])]);
				for (const extensions of await Promise.all([...pendingDev, pendingUser, pendingSystem])) {
					for (let i = extensions.length - 1; i >= 0; i--) {
						const extension = extensions[i];
						const key = ExtensionIdentifier.toKey(extension.identifier);
						if (skipExtensions.has(key)) {
							continue;
						}
						skipExtensions.add(key);
						result.unshift(transformOutgoingURIs(extension, uriTranformer));
					}
				}
				return result;
			}
			logService.error('Unknown command: RemoteExtensionsEnvironment.' + command);
			throw new Error('Unknown command: RemoteExtensionsEnvironment.' + command);
		}
		listen(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
			logService.error('Unknown event: RemoteExtensionsEnvironment.' + event);
			throw new Error('Unknown event: RemoteExtensionsEnvironment.' + event);
		}
	}
	channelServer.registerChannel('remoteextensionsenvironment', new RemoteExtensionsEnvironment());

	// see used APIs in src/vs/workbench/services/remote/common/remoteAgentFileSystemChannel.ts
	class RemoteFileSystem implements IServerChannel<RemoteAgentConnectionContext> {
		protected readonly watchers = new Map<string, {
			watcher: DiskFileSystemProvider,
			emitter: Emitter<IFileChangeDto[] | string>
		}>();
		protected readonly watchHandles = new Map<string, IDisposable>();
		async call(ctx: RemoteAgentConnectionContext, command: string, arg?: any, cancellationToken?: CancellationToken | undefined): Promise<any> {
			if (command === 'stat') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.stat(URI.revive(uriTranformer.transformIncoming(arg[0])));
			}
			if (command === 'open') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.open(URI.revive(uriTranformer.transformIncoming(arg[0])), arg[1]);
			}
			if (command === 'close') {
				return diskFileSystemProvider.close(arg[0]);
			}
			if (command === 'read') {
				const length = arg[2];
				const data = VSBuffer.alloc(length);
				const read = await diskFileSystemProvider.read(arg[0], arg[1], data.buffer, 0, length);
				return [read, data.slice(0, read)];
			}
			if (command === 'readFile') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				const data = await diskFileSystemProvider.readFile(URI.revive(uriTranformer.transformIncoming(arg[0])));
				return VSBuffer.wrap(data);
			}
			if (command === 'write') {
				const data = arg[2] as VSBuffer;
				await diskFileSystemProvider.write(arg[0], arg[1], data.buffer, arg[3], arg[4]);
				return;
			}
			if (command === 'writeFile') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				const data = arg[1] as VSBuffer;
				await diskFileSystemProvider.writeFile(URI.revive(uriTranformer.transformIncoming(arg[0])), data.buffer, arg[2]);
				return;
			}
			if (command === 'delete') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				await diskFileSystemProvider.delete(URI.revive(uriTranformer.transformIncoming(arg[0])), arg[1]);
				return;
			}
			if (command === 'mkdir') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				await diskFileSystemProvider.mkdir(URI.revive(uriTranformer.transformIncoming(arg[0])));
				return;
			}
			if (command === 'readdir') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.readdir(URI.revive(uriTranformer.transformIncoming(arg[0])));
			}
			if (command === 'rename') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.rename(
					URI.revive(uriTranformer.transformIncoming(arg[0])),
					URI.revive(uriTranformer.transformIncoming(arg[1])),
					arg[2]
				);
			}
			if (command === 'copy') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.copy(
					URI.revive(uriTranformer.transformIncoming(arg[0])),
					URI.revive(uriTranformer.transformIncoming(arg[1])),
					arg[2]
				);
			}
			if (command === 'watch') {
				const watcher = this.watchers.get(arg[0])?.watcher;
				if (watcher) {
					const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
					const unwatch = watcher.watch(URI.revive(uriTranformer.transformIncoming(arg[2])), arg[3]);
					this.watchHandles.set(
						arg[0] + ':' + arg[1],
						unwatch
					);
				} else {
					logService.error(`'filechange' event should be called before 'watch' first request`);
				}
				return;
			}
			if (command === 'unwatch') {
				this.watchHandles.get(arg[0] + ':' + arg[1])?.dispose();
				this.watchHandles.delete(arg[0] + ':' + arg[1]);
				return;
			}
			logService.error('Unknown command: RemoteFileSystem.' + command);
			throw new Error('Unknown command: RemoteFileSystem.' + command);
		}
		protected obtainFileChangeEmitter(ctx: RemoteAgentConnectionContext, session: string): Emitter<IFileChangeDto[] | string> {
			let existing = this.watchers.get(session);
			if (existing) {
				return existing.emitter;
			}
			const watcher = new DiskFileSystemProvider(logService);
			const emitter = new Emitter<IFileChangeDto[] | string>({
				onLastListenerRemove: () => {
					this.watchers.delete(session);
					emitter.dispose();
					watcher.dispose();
					logService.info(`[session:${session}] closed watching fs`);
				}
			});
			logService.info(`[session:${session}] started watching fs`);
			this.watchers.set(session, { watcher, emitter });

			const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
			watcher.onDidChangeFile(changes => emitter.fire(
				changes.map(change => ({
					resource: uriTranformer.transformOutgoingURI(change.resource),
					type: change.type
				} as IFileChangeDto))
			));
			watcher.onDidErrorOccur(error => emitter.fire(error));
			return emitter;
		}
		listen(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
			if (event === 'filechange') {
				return this.obtainFileChangeEmitter(ctx, arg[0]).event;
			}
			if (event === 'readFileStream') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				const resource = URI.revive(transformIncomingURIs(arg[0], uriTranformer));
				const emitter = new Emitter<ReadableStreamEventPayload<VSBuffer>>({
					onLastListenerRemove: () => {
						cancellationTokenSource.cancel();
					}
				});
				const cancellationTokenSource = new CancellationTokenSource();
				const stream = diskFileSystemProvider.readFileStream(resource, arg[1], cancellationTokenSource.token);
				stream.on('data', data => emitter.fire(VSBuffer.wrap(data)));
				stream.on('error', error => emitter.fire(error));
				stream.on('end', () => {
					emitter.fire('end');
					emitter.dispose();
					cancellationTokenSource.dispose();
				});
				return emitter.event;
			}
			logService.error('Unknown event: RemoteFileSystem.' + event);
			throw new Error('Unknown event: RemoteFileSystem.' + event);
		}
	}
	channelServer.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, new RemoteFileSystem());

	// Init services
	const services = new ServiceCollection();
	services.set(IRawURITransformerFactory, rawURITransformerFactory);

	services.set(IEnvironmentService, environmentService);
	services.set(INativeEnvironmentService, environmentService);
	services.set(ILogService, logService);
	services.set(ITelemetryService, NullTelemetryService);

	services.set(IFileService, fileService);

	services.set(IConfigurationService, new SyncDescriptor(ConfigurationService, [environmentService.settingsResource, fileService]));
	services.set(IProductService, productService);
	services.set(IRequestService, new SyncDescriptor(RequestService));
	services.set(IDownloadService, new SyncDescriptor(DownloadService));

	services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));
	services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));

	services.set(IRequestService, new SyncDescriptor(RequestService));

	if (options.configure) {
		options.configure(services, channelServer);
	}

	let resolveExtensionsInstalled: (value?: unknown) => void;
	const extensionsInstalled = new Promise(resolve => resolveExtensionsInstalled = resolve);

	// Startup
	const instantiationService = new InstantiationService(services);
	instantiationService.invokeFunction(accessor => {
		let startResult = undefined;
		if (options.start) {
			startResult = options.start(accessor, channelServer);
		}
		if (startResult && startResult.installingInitialExtensions) {
			startResult.installingInitialExtensions.then(resolveExtensionsInstalled);
		} else {
			resolveExtensionsInstalled();
		}

		const extensionManagementService = accessor.get(IExtensionManagementService);
		channelServer.registerChannel('extensions', new ExtensionManagementChannel(extensionManagementService, requestContext => new URITransformer(rawURITransformerFactory(requestContext))));
		(extensionManagementService as ExtensionManagementService).removeDeprecatedExtensions();

		const requestService = accessor.get(IRequestService);
		channelServer.registerChannel('request', new RequestChannel(requestService));

		// Delay creation of spdlog for perf reasons (https://github.com/microsoft/vscode/issues/72906)
		bufferLogService.logger = new SpdLogLogger('main', join(environmentService.logsPath, `${RemoteExtensionLogFileName}.log`), true, bufferLogService.getLevel());

		const clients = new Map<string, Client>();

		const server = http.createServer(async (req, res) => {
			if (!req.url) {
				return serveError(req, res, 400, 'Bad Request.');
			}
			try {
				const parsedUrl = url.parse(req.url, true);
				const pathname = parsedUrl.pathname;

				if (options.handleRequest && await instantiationService.invokeFunction(accessor => options.handleRequest!(pathname, req, res, accessor, channelServer))) {
					return;
				}

				//#region headless
				if (pathname === '/vscode-remote-resource') {
					const filePath = parsedUrl.query['path'];
					const fsPath = typeof filePath === 'string' && URI.from({ scheme: 'file', path: filePath }).fsPath;
					if (!fsPath) {
						return serveError(req, res, 400, 'Bad Request.');
					}
					return serveFile(logService, req, res, fsPath);
				}
				//#region headless end

				//#region static
				if (pathname === '/') {
					return handleRoot(req, res, devMode ? options.mainDev || WEB_MAIN_DEV : options.main || WEB_MAIN, environmentService);
				}

				if (pathname === '/callback') {
					return handleCallback(logService, req, res, parsedUrl);
				}

				if (pathname === '/fetch-callback') {
					return handleFetchCallback(req, res, parsedUrl);
				}

				if (pathname === '/manifest.json') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					return res.end(JSON.stringify({
						'name': product.nameLong,
						'short_name': product.nameShort,
						'start_url': '/',
						'lang': 'en-US',
						'display': 'standalone'
					}));
				}
				if (pathname) {
					let relativeFilePath;
					if (/^\/static\//.test(pathname)) {
						relativeFilePath = path.normalize(decodeURIComponent(pathname.substr('/static/'.length)));
					} else {
						relativeFilePath = path.normalize(decodeURIComponent(pathname));
					}
					return serveFile(logService, req, res, path.join(APP_ROOT, relativeFilePath));
				}
				//#region static end

				logService.error(`${req.method} ${req.url} not found`);
				return serveError(req, res, 404, 'Not found.');
			} catch (error) {
				logService.error(error);

				return serveError(req, res, 500, 'Internal Server Error.');
			}
		});
		server.on('error', e => logService.error(e));
		server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
			if (req.headers['upgrade'] !== 'websocket' || !req.url) {
				logService.error(`failed to upgrade for header "${req.headers['upgrade']}" and url: "${req.url}".`);
				socket.end('HTTP/1.1 400 Bad Request');
				return;
			}
			const { query } = url.parse(req.url, true);
			// /?reconnectionToken=c0e3a8af-6838-44fb-851b-675401030831&reconnection=false&skipWebSocketFrames=false
			const reconnection = 'reconnection' in query && query['reconnection'] === 'true';
			let token: string | undefined;
			if ('reconnectionToken' in query && typeof query['reconnectionToken'] === 'string') {
				token = query['reconnectionToken'];
			}
			// TODO skipWebSocketFrames (support of VS Code desktop?)
			if (!token) {
				logService.error(`missing token for "${req.url}".`);
				socket.end('HTTP/1.1 400 Bad Request');
				return;
			}
			logService.info(`[${token}] Socket upgraded for "${req.url}".`);
			socket.on('error', e => {
				logService.error(`[${token}] Socket failed for "${req.url}".`, e);
			});

			const acceptKey = req.headers['sec-websocket-key'];
			const hash = crypto.createHash('sha1').update(acceptKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
			const responseHeaders = ['HTTP/1.1 101 Web Socket Protocol Handshake', 'Upgrade: WebSocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${hash}`];

			let permessageDeflate = false;
			if (String(req.headers['sec-websocket-extensions']).indexOf('permessage-deflate') !== -1) {
				permessageDeflate = true;
				responseHeaders.push('Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=15');
			}

			socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

			const client = clients.get(token) || {};
			clients.set(token, client);

			const webSocket = new WebSocketNodeSocket(new NodeSocket(socket), permessageDeflate, null, permessageDeflate);
			const protocol = new PersistentProtocol(webSocket);
			const controlListener = protocol.onControlMessage(async raw => {
				const msg = <HandshakeMessage>JSON.parse(raw.toString());
				if (msg.type === 'error') {
					logService.error(`[${token}] error control message:`, msg.reason);
					safeDisposeProtocolAndSocket(protocol);
				} else if (msg.type === 'auth') {
					protocol.sendControl(VSBuffer.fromString(JSON.stringify({
						type: 'sign',
						data: productService.nameShort + ' Server'
					} as SignRequest)));
				} else if (msg.type === 'connectionType') {
					controlListener.dispose();
					// TODO version matching msg.commit
					// TODO auth check msg.signedData
					for (const [token, client] of clients) {
						if (client.management) {
							if (client.management.graceTimeReconnection.isScheduled() && !client.management.shortGraceTimeReconnection.isScheduled()) {
								logService.info(`[${token}] Another connection is established, closing this connection after ${ProtocolConstants.ReconnectionShortGraceTime}ms reconnection timeout.`);
								client.management.shortGraceTimeReconnection.schedule();
							}
						}
						if (client.extensionHost) {
							client.extensionHost.send({
								type: 'VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME'
							});
						}
					}
					if (msg.desiredConnectionType === ConnectionType.Management) {
						if (!reconnection) {
							if (client.management) {
								logService.error(`[${token}] Falied to connect: management connection is already running.`);
								protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Management connection is already running.' } as ErrorMessage)));
								safeDisposeProtocolAndSocket(protocol);
								return;
							}

							const onDidClientDisconnectEmitter = new Emitter<void>();
							let disposed = false;
							function dispose(): void {
								if (disposed) {
									return;
								}
								disposed = true;
								graceTimeReconnection.dispose();
								shortGraceTimeReconnection.dispose();
								client.management = undefined;
								protocol.sendDisconnect();
								const socket = protocol.getSocket();
								protocol.dispose();
								socket.end();
								onDidClientDisconnectEmitter.fire(undefined);
								onDidClientDisconnectEmitter.dispose();
								logService.info(`[${token}] Management connection is disposed.`);
							}

							protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'ok' } as OKMessage)));
							const graceTimeReconnection = new RunOnceScheduler(() => {
								logService.info(`[${token}] Management connection expired after ${ProtocolConstants.ReconnectionGraceTime}ms (grace).`);
								dispose();
							}, ProtocolConstants.ReconnectionGraceTime);
							const shortGraceTimeReconnection = new RunOnceScheduler(() => {
								logService.info(`[${token}] Management connection expired after ${ProtocolConstants.ReconnectionShortGraceTime}ms (short grace).`);
								dispose();
							}, ProtocolConstants.ReconnectionShortGraceTime);
							client.management = { protocol, graceTimeReconnection, shortGraceTimeReconnection };
							protocol.onDidDispose(() => dispose());
							protocol.onSocketClose(() => {
								logService.info(`[${token}] Management connection socket is closed, waiting to reconnect within ${ProtocolConstants.ReconnectionGraceTime}ms.`);
								graceTimeReconnection.schedule();
							});
							onDidClientConnectEmitter.fire({ protocol, onDidClientDisconnect: onDidClientDisconnectEmitter.event });
							logService.info(`[${token}] Management connection is connected.`);
						} else {
							if (!client.management) {
								logService.error(`[${token}] Failed to reconnect: management connection is not running.`);
								protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Management connection is not running.' } as ErrorMessage)));
								safeDisposeProtocolAndSocket(protocol);
								return;
							}

							protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'ok' } as OKMessage)));
							client.management.graceTimeReconnection.cancel();
							client.management.shortGraceTimeReconnection.cancel();
							client.management.protocol.beginAcceptReconnection(protocol.getSocket(), protocol.readEntireBuffer());
							client.management.protocol.endAcceptReconnection();
							protocol.dispose();
							logService.info(`[${token}] Management connection is reconnected.`);
						}
					} else if (msg.desiredConnectionType === ConnectionType.ExtensionHost) {
						const params: IRemoteExtensionHostStartParams = {
							language: 'en',
							...msg.args
							// TODO what if params.port is 0?
						};

						if (!reconnection) {
							if (client.extensionHost) {
								logService.error(`[${token}] Falied to connect: extension host is already running.`);
								protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Extension host is already running.' } as ErrorMessage)));
								safeDisposeProtocolAndSocket(protocol);
								return;
							}

							protocol.sendControl(VSBuffer.fromString(JSON.stringify({ debugPort: params.port } /* Omit<IExtensionHostConnectionResult, 'protocol'> */)));
							const initialDataChunk = Buffer.from(protocol.readEntireBuffer().buffer).toString('base64');
							protocol.dispose();
							socket.pause();
							await webSocket.drain();

							try {
								// see src/vs/workbench/services/extensions/electron-browser/localProcessExtensionHost.ts
								const opts: cp.ForkOptions = {
									env: {
										...process.env,
										VSCODE_AMD_ENTRYPOINT: 'vs/workbench/services/extensions/node/extensionHostProcess',
										VSCODE_PIPE_LOGGING: 'true',
										VSCODE_VERBOSE_LOGGING: 'true',
										VSCODE_LOG_NATIVE: 'false',
										VSCODE_EXTHOST_WILL_SEND_SOCKET: 'true',
										VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
										VSCODE_LOG_STACK: 'true',
										VSCODE_LOG_LEVEL: environmentService.verbose ? 'trace' : environmentService.logLevel
									},
									// see https://github.com/akosyakov/gitpod-code/blob/33b49a273f1f6d44f303426b52eaf89f0f5cc596/src/vs/base/parts/ipc/node/ipc.cp.ts#L72-L78
									execArgv: [],
									silent: true
								};
								if (typeof params.port === 'number') {
									if (params.port !== 0) {
										opts.execArgv = [
											'--nolazy',
											(params.break ? '--inspect-brk=' : '--inspect=') + params.port
										];
									} else {
										// TODO we should return a dynamically allocated port to the client,
										// it is better to avoid it?
										opts.execArgv = ['--inspect-port=0'];
									}
								}
								if (options.configureExtensionHostForkOptions) {
									instantiationService.invokeFunction(accessor => options.configureExtensionHostForkOptions!(opts, accessor, channelServer));
								}
								const extensionHost = cp.fork(FileAccess.asFileUri('bootstrap-fork', require).fsPath, ['--type=extensionHost', '--uriTransformerPath=' + uriTransformerPath], opts);
								extensionHost.stdout!.setEncoding('utf8');
								extensionHost.stderr!.setEncoding('utf8');
								Event.fromNodeEventEmitter<string>(extensionHost.stdout!, 'data')(msg => logService.info(`[${token}][extension host][${extensionHost.pid}][stdout] ${msg}`));
								Event.fromNodeEventEmitter<string>(extensionHost.stderr!, 'data')(msg => logService.info(`[${token}][extension host][${extensionHost.pid}][stderr] ${msg}`));
								extensionHost.on('message', msg => {
									if (msg && (<IRemoteConsoleLog>msg).type === '__$console') {
										logService.info(`[${token}][extension host][${extensionHost.pid}][__$console] ${(<IRemoteConsoleLog>msg).arguments}`);
									}
								});

								let disposed = false;
								let toDispose: IDisposable = { dispose: () => { } };
								function dispose(): void {
									if (disposed) {
										return;
									}
									disposed = true;
									toDispose.dispose();
									socket.end();
									extensionHost.kill();
									client.extensionHost = undefined;
									logService.info(`[${token}] Extension host is disconnected.`);
								}

								extensionHost.on('error', err => {
									dispose();
									logService.error(`[${token}] Extension host failed with: `, err);
								});
								extensionHost.on('exit', (code: number, signal: string) => {
									dispose();
									if (code !== 0 && signal !== 'SIGTERM') {
										logService.error(`[${token}] Extension host exited with code: ${code} and signal: ${signal}.`);
									}
								});

								const readyListener = (msg: any) => {
									if (msg && (<IExtHostReadyMessage>msg).type === 'VSCODE_EXTHOST_IPC_READY') {
										extensionHost.removeListener('message', readyListener);
										const inflateBytes = Buffer.from(webSocket.recordedInflateBytes.buffer).toString('base64');
										extensionHost.send({
											type: 'VSCODE_EXTHOST_IPC_SOCKET',
											initialDataChunk,
											skipWebSocketFrames: false, // TODO skipWebSocketFrames - i.e. when we connect from Node (VS Code?)
											permessageDeflate,
											inflateBytes
										} as IExtHostSocketMessage, socket);
										logService.info(`[${token}] Extension host is connected.`);
									}
								};
								extensionHost.on('message', readyListener);

								if (options.configureExtensionHostProcess) {
									toDispose = instantiationService.invokeFunction(accessor => options.configureExtensionHostProcess!(extensionHost, accessor, channelServer));
								}
								client.extensionHost = extensionHost;
								logService.info(`[${token}] Extension host is started.`);
							} catch (e) {
								logService.error(`[${token}] Failed to start the extension host process: `, e);
							}
						} else {
							if (!client.extensionHost) {
								logService.error(`[${token}] Failed to reconnect: extension host is not running.`);
								protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Extension host is not running.' } as ErrorMessage)));
								safeDisposeProtocolAndSocket(protocol);
								return;
							}

							protocol.sendControl(VSBuffer.fromString(JSON.stringify({ debugPort: params.port } /* Omit<IExtensionHostConnectionResult, 'protocol'> */)));
							const initialDataChunk = Buffer.from(protocol.readEntireBuffer().buffer).toString('base64');
							protocol.dispose();
							socket.pause();
							await webSocket.drain();

							const inflateBytes = Buffer.from(webSocket.recordedInflateBytes.buffer).toString('base64');
							client.extensionHost.send({
								type: 'VSCODE_EXTHOST_IPC_SOCKET',
								initialDataChunk,
								skipWebSocketFrames: false, // TODO skipWebSocketFrames - i.e. when we connect from Node (VS Code?)
								permessageDeflate,
								inflateBytes
							} as IExtHostSocketMessage, socket);
							logService.info(`[${token}] Extension host is reconnected.`);
						}
					} else {
						logService.error(`[${token}] Unexpected connection type:`, msg.desiredConnectionType);
						safeDisposeProtocolAndSocket(protocol);
					}
				} else {
					logService.error(`[${token}] Unexpected control message:`, msg.type);
					safeDisposeProtocolAndSocket(protocol);
				}
			});
		});

		let port = 3000;
		if (parsedArgs.port) {
			port = Number(parsedArgs.port);
		} else if (typeof options.port === 'number') {
			port = options.port;
		}
		const host = parsedArgs.host || '0.0.0.0';
		server.listen(port, host, () => {
			const addressInfo = server.address() as net.AddressInfo;
			const address = addressInfo.address === '0.0.0.0' || addressInfo.address === '127.0.0.1' ? 'localhost' : addressInfo.address;
			const port = addressInfo.port === 80 ? '' : String(addressInfo.port);
			logService.info(`Web UI available at http://${address}:${port}`);
		});
	});
}
