import React, { useState, useEffect } from 'react';
import { Box } from '@mui/material';
import Header from './components/Header';
import Dashboard from './components/Dashboard';
import CameraSettings from './components/CameraSettings';
import LoaderSettings from './components/LoaderSettings';
import SystemStatus from './components/SystemStatus';
import { wsService } from './services/websocket';
import type {SystemState} from './types';

const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [state, setState] = useState<SystemState>({
    cameras: [],
    loaders: [],
  });

  useEffect(() => {
    wsService.connect(
      (newState) => setState(newState),
      (connected) => setWsConnected(connected)
    );

    return () => {
      wsService.disconnect();
    };
  }, []);

  const renderContent = () => {
    switch (currentTab) {
      case 0:
        return <Dashboard state={state} />;
      case 1:
        return <CameraSettings />;
      case 2:
        return <LoaderSettings />;
      case 3:
        return <SystemStatus />;
      default:
        return <Dashboard state={state} />;
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: '#f5f5f5' }}>
      <Header
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        wsConnected={wsConnected}
      />
      <Box sx={{ py: 4 }}>
        {renderContent()}
      </Box>
    </Box>
  );
};

export default App;