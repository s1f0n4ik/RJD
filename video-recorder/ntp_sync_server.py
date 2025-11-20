#!/usr/bin/env python3
"""
NTP Synchronization Server with REST API
Provides time synchronization service for camera network
"""

import asyncio
import logging
from datetime import datetime
from typing import Dict, List
from aiohttp import web
import ntplib
import json
from dataclasses import dataclass, asdict
import socket

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@dataclass
class ClientSyncInfo:
    """Client synchronization information"""
    client_id: str
    ip_address: str
    last_sync: datetime
    offset: float
    delay: float
    stratum: int


class NTPSyncServer:
    """NTP Server with monitoring and API"""

    def __init__(self, port: int = 8123):
        self.port = port
        self.clients: Dict[str, ClientSyncInfo] = {}
        self.app = web.Application()
        self.setup_routes()

    def setup_routes(self):
        """Setup REST API routes"""
        self.app.router.add_get('/health', self.health_check)
        self.app.router.add_get('/status', self.get_status)
        self.app.router.add_get('/clients', self.get_clients)
        self.app.router.add_post('/sync', self.sync_client)
        self.app.router.add_get('/time', self.get_server_time)

    async def health_check(self, request: web.Request) -> web.Response:
        """Health check endpoint"""
        return web.json_response({'status': 'healthy'})

    async def get_status(self, request: web.Request) -> web.Response:
        """Get server status"""
        status = {
            'server_time': datetime.now().isoformat(),
            'active_clients': len(self.clients),
            'uptime': self._get_uptime()
        }
        return web.json_response(status)

    async def get_clients(self, request: web.Request) -> web.Response:
        """Get list of synchronized clients"""
        clients_data = []
        for client_info in self.clients.values():
            data = asdict(client_info)
            data['last_sync'] = client_info.last_sync.isoformat()
            clients_data.append(data)

        return web.json_response({'clients': clients_data})

    async def sync_client(self, request: web.Request) -> web.Response:
        """Synchronize client time"""
        try:
            data = await request.json()
            client_id = data.get('client_id')
            client_time = data.get('client_time')

            if not client_id or not client_time:
                return web.json_response(
                    {'error': 'Missing required fields'},
                    status=400
                )

            # Calculate offset
            server_time = datetime.now()
            client_dt = datetime.fromisoformat(client_time)
            offset = (server_time - client_dt).total_seconds()

            # Store client info
            self.clients[client_id] = ClientSyncInfo(
                client_id=client_id,
                ip_address=request.remote,
                last_sync=server_time,
                offset=offset,
                delay=0.0,  # TODO: Calculate network delay
                stratum=1
            )

            response = {
                'server_time': server_time.isoformat(),
                'offset': offset,
                'status': 'synchronized'
            }

            logger.info(f"Client {client_id} synchronized. Offset: {offset:.3f}s")
            return web.json_response(response)

        except Exception as e:
            logger.error(f"Sync error: {e}")
            return web.json_response(
                {'error': str(e)},
                status=500
            )

    async def get_server_time(self, request: web.Request) -> web.Response:
        """Get current server time"""
        return web.json_response({
            'server_time': datetime.now().isoformat(),
            'timestamp': datetime.now().timestamp()
        })

    def _get_uptime(self) -> str:
        """Get server uptime"""
        # Simplified uptime calculation
        return "N/A"

    async def start(self):
        """Start the NTP sync server"""
        logger.info(f"Starting NTP Sync Server on port {self.port}")
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, '0.0.0.0', self.port)
        await site.start()
        logger.info(f"NTP Sync Server running on http://0.0.0.0:{self.port}")


async def main():
    """Main entry point"""
    server = NTPSyncServer(port=8123)
    await server.start()

    # Keep running
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())