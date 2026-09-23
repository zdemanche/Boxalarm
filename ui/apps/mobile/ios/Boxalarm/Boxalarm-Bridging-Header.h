// react-native-app-auth ships as a plain static-lib pod with no Swift module map, so its
// AppDelegate integration protocols reach Swift through this bridging header instead of `import`.
#import "RNAppAuthAuthorizationFlowManager.h"
#import "RNAppAuthAuthorizationFlowManagerDelegate.h"
