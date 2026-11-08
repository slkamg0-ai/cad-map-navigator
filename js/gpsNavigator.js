/**
 * Real-time Mobile GPS & Compass Waypoint Navigation Engine
 */

export class GpsNavigator {
  constructor(callbacks = {}) {
    this.callbacks = callbacks; // onLocationUpdate, onOrientationUpdate, onArrival
    this.watchId = null;
    this.currentPosition = null; // { lat, lng, accuracy, heading, speed, altitude }
    this.compassHeading = null; // 0-360 degrees (0 = North, 90 = East)
    this.targetWaypoint = null; // { lat, lng, cadX, cadY, name }
    this.isSimulating = false;
    this.orientationHandler = null;
    this.hasArrived = false;
  }

  /**
   * Start GPS tracking
   */
  startTracking() {
    if (!('geolocation' in navigator)) {
      throw new Error('이 브라우저/기기는 GPS 위치 정보를 지원하지 않습니다.');
    }

    if (window.isSecureContext === false && location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      if (this.callbacks.onGpsError) {
        this.callbacks.onGpsError({ code: 1, message: 'Secure context required for mobile GPS' });
        return;
      }
    }

    const options = {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    };

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handleGeoSuccess(pos),
      (err) => this.handleGeoError(err),
      options
    );

    this.startOrientationTracking();
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.stopOrientationTracking();
  }

  handleGeoSuccess(pos) {
    if (this.isSimulating) return;

    this.currentPosition = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy, // meters
      heading: pos.coords.heading,
      speed: pos.coords.speed,
      altitude: pos.coords.altitude,
      timestamp: pos.timestamp
    };

    if (this.callbacks.onLocationUpdate) {
      this.callbacks.onLocationUpdate(this.currentPosition, this.getNavState());
    }

    this.checkWaypointProximity();
  }

  handleGeoError(err) {
    console.warn('GPS Error:', err.message, err.code);
    if (this.callbacks.onGpsError) {
      this.callbacks.onGpsError(err);
    }
  }

  /**
   * Device Orientation (Compass)
   */
  async startOrientationTracking() {
    // iOS 13+ requires explicit permission request
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const response = await DeviceOrientationEvent.requestPermission();
        if (response !== 'granted') {
          console.warn('나침반 센서 접근 권한이 거부되었습니다.');
          return;
        }
      } catch (e) {
        console.warn('DeviceOrientation permission error:', e);
      }
    }

    this.orientationHandler = (event) => {
      let heading = null;

      if (event.webkitCompassHeading) {
        // iOS Safari gives accurate magnetic compass heading (0 = North)
        heading = event.webkitCompassHeading;
      } else if (event.alpha !== null) {
        // Android Chrome / Standard
        if (event.absolute) {
          heading = 360 - event.alpha;
        } else {
          heading = 360 - event.alpha;
        }
      }

      if (heading !== null) {
        this.compassHeading = (heading + 360) % 360;
        if (this.callbacks.onOrientationUpdate) {
          this.callbacks.onOrientationUpdate(this.compassHeading, this.getNavState());
        }
      }
    };

    // Prefer deviceorientationabsolute for Android if available
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this.orientationHandler, true);
    } else if ('DeviceOrientationEvent' in window) {
      window.addEventListener('deviceorientation', this.orientationHandler, true);
    }
  }

  stopOrientationTracking() {
    if (this.orientationHandler) {
      window.removeEventListener('deviceorientationabsolute', this.orientationHandler, true);
      window.removeEventListener('deviceorientation', this.orientationHandler, true);
      this.orientationHandler = null;
    }
  }

  /**
   * Set target CAD waypoint to navigate to
   */
  setTargetWaypoint(waypoint) {
    this.targetWaypoint = waypoint; // { lat, lng, cadX, cadY, name }
    this.hasArrived = false;
    return this.getNavState();
  }

  clearTargetWaypoint() {
    this.targetWaypoint = null;
    this.hasArrived = false;
  }

  /**
   * Set simulated position for desktop testing or field preview
   */
  setSimulatedPosition(lat, lng, accuracy = 2.0) {
    this.isSimulating = true;
    this.currentPosition = {
      lat,
      lng,
      accuracy,
      heading: this.compassHeading || 0,
      speed: 1.2, // ~4.3 km/h walking speed
      timestamp: Date.now()
    };

    if (this.callbacks.onLocationUpdate) {
      this.callbacks.onLocationUpdate(this.currentPosition, this.getNavState());
    }

    this.checkWaypointProximity();
  }

  /**
   * Calculate distance (meters) between two LatLngs using Haversine formula
   */
  static getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Calculate initial bearing (0-360 degrees) from (lat1, lon1) to (lat2, lon2)
   */
  static getBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;

    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    const brng = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return brng;
  }

  /**
   * Get formatted bearing direction name in Korean (북, 북동, 동, 남동, ...)
   */
  static getDirectionKorean(bearing) {
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    const idx = Math.round(bearing / 45) % 8;
    return dirs[idx];
  }

  /**
   * Get full navigation state relative to current waypoint
   */
  getNavState() {
    if (!this.targetWaypoint) {
      return { hasTarget: false };
    }

    if (!this.currentPosition) {
      return {
        hasTarget: true,
        target: this.targetWaypoint,
        waitingGps: true
      };
    }

    const dist = GpsNavigator.getDistance(
      this.currentPosition.lat,
      this.currentPosition.lng,
      this.targetWaypoint.lat,
      this.targetWaypoint.lng
    );

    const bearing = GpsNavigator.getBearing(
      this.currentPosition.lat,
      this.currentPosition.lng,
      this.targetWaypoint.lat,
      this.targetWaypoint.lng
    );

    // Relative angle: how much user needs to turn relative to compass heading
    // 0 = straight ahead, +90 = right, -90 = left
    let relativeAngle = bearing;
    if (this.compassHeading !== null) {
      relativeAngle = (bearing - this.compassHeading + 360) % 360;
      if (relativeAngle > 180) relativeAngle -= 360;
    }

    return {
      hasTarget: true,
      target: this.targetWaypoint,
      distance: dist, // in meters
      bearing: bearing, // absolute bearing (0-360)
      directionName: GpsNavigator.getDirectionKorean(bearing),
      compassHeading: this.compassHeading,
      relativeAngle: relativeAngle, // relative to current device orientation
      accuracy: this.currentPosition.accuracy,
      isClose: dist <= 10.0,
      isArrived: dist <= 2.5
    };
  }

  checkWaypointProximity() {
    if (!this.targetWaypoint || !this.currentPosition) return;

    const nav = this.getNavState();
    if (nav.isArrived && !this.hasArrived) {
      this.hasArrived = true;
      if ('vibrate' in navigator) {
        navigator.vibrate([200, 100, 200, 100, 300]);
      }
      if (this.callbacks.onArrival) {
        this.callbacks.onArrival(this.targetWaypoint, nav);
      }
    }
  }
}
