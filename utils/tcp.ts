import { Socket as TCPSocket } from 'net';
import { PromiseSocket } from 'promise-socket';
import { CONNECT_TIMEOUT } from '../types';
import type { Logger } from '../types/logger';
import { noopLogger } from '../types/logger';

export type Connection = PromiseSocket<TCPSocket>;

export async function connect(p_ip: string, p_port: number, logger: Logger = noopLogger): Promise<Connection> {
	const socket = new TCPSocket();
	const promiseSocket = new PromiseSocket(socket);
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promiseSocket.connect(p_port, p_ip),
			new Promise<never>((_resolve, reject) => {
				deadline = setTimeout(() => {
					const error = new Error('TCP connection timed out after ' + CONNECT_TIMEOUT + 'ms');
					socket.destroy(error);
					reject(error);
				}, CONNECT_TIMEOUT);
			}),
		]);
	} catch (e) {
		socket.destroy();
		throw new Error(`Failed to connect to '${p_ip}:${p_port}': ${e}`);
	} finally {
		clearTimeout(deadline);
	}
	logger.debug(`TCP connection to '${p_ip}:${p_port}' local port: ${promiseSocket.socket.localPort}`);
	return promiseSocket;
}
