import UIKit

@objc(IOSHaptics)
class IOSHaptics: CDVPlugin {

    // MARK: - Impact feedback

    @objc(impact:)
    func impact(command: CDVInvokedUrlCommand) {
        let style = resolveImpactStyle(command.arguments?.first)
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        generator.impactOccurred()
        commandDelegate.send(CDVPluginResult(status: CDVCommandStatus_OK), callbackId: command.callbackId)
    }

    // MARK: - Notification feedback

    @objc(notification:)
    func notification(command: CDVInvokedUrlCommand) {
        let type = resolveNotificationType(command.arguments?.first)
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(type)
        commandDelegate.send(CDVPluginResult(status: CDVCommandStatus_OK), callbackId: command.callbackId)
    }

    // MARK: - Selection feedback

    @objc(selection:)
    func selection(command: CDVInvokedUrlCommand) {
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
        commandDelegate.send(CDVPluginResult(status: CDVCommandStatus_OK), callbackId: command.callbackId)
    }

    // MARK: - Helpers

    private func resolveImpactStyle(_ arg: Any?) -> UIImpactFeedbackGenerator.FeedbackStyle {
        var raw: String?

        if let dict = arg as? [String: Any] {
            raw = dict["style"] as? String
        } else if let str = arg as? String {
            raw = str
        }

        switch raw?.lowercased() {
        case "light":  return .light
        case "medium": return .medium
        case "heavy":  return .heavy
        case "soft":   return .soft
        case "rigid":  return .rigid
        default:       return .medium
        }
    }

    private func resolveNotificationType(_ arg: Any?) -> UINotificationFeedbackGenerator.FeedbackType {
        var raw: String?

        if let dict = arg as? [String: Any] {
            raw = dict["type"] as? String
        } else if let str = arg as? String {
            raw = str
        }

        switch raw?.lowercased() {
        case "success": return .success
        case "warning": return .warning
        case "error":   return .error
        default:        return .success
        }
    }
}
