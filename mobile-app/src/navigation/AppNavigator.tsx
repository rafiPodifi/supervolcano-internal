/**
 * APP NAVIGATOR
 * Routes to Owner or Cleaner stack based on user role
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View, StyleSheet } from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import SplashScreen from '../components/SplashScreen';
import LoginScreen from '../screens/LoginScreen';
import OwnerNavigator from './OwnerNavigator';
import CleanerNavigator from './CleanerNavigator';

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  const { user, userProfile, loading } = useAuth();

  const renderStack = () => {
    if (!user) {
      return (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Login" component={LoginScreen} />
        </Stack.Navigator>
      );
    }

    const role = userProfile?.role;
    console.log('[AppNavigator] User role:', role);

    if (role === 'location_owner') {
      return <OwnerNavigator />;
    }

    return <CleanerNavigator />;
  };

  return (
    <View style={styles.root}>
      {renderStack()}
      {loading && (
        <View style={styles.splashOverlay} pointerEvents="box-none">
          <SplashScreen onComplete={() => {}} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  splashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
});
