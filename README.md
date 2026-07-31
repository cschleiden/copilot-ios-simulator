# iOS Simulator canvas for GitHub Copilot App

An embedded iOS Simulator canvas for GitHub Copilot App. It provides live simulator video, device selection and lifecycle controls, touch and keyboard input, rotation, screenshots, configurable streaming, and safe agent-control leasing.

## Requirements

- macOS 15 or later
- Xcode with at least one iOS Simulator runtime installed
- Swift 6.1 or later

## Installation

### Install from GitHub (recommended)

In GitHub Copilot App, paste this prompt:

```text
Install the extension from https://github.com/cschleiden/copilot-ios-simulator/tree/main/.github/extensions/ios-simulator
```

When prompted, choose an installation scope:

- **User** makes the extension available across all your projects.
- **Project** installs it in the current repository for the whole team.
- **Session** installs it only for the current Copilot session.

The URL must point to the `ios-simulator` extension directory, not the repository root. Copilot installs the complete directory, including its native Swift source and web assets. After installation, open the **iOS Simulator** canvas and select a device. The Swift bridge builds automatically on first use.

### Install manually

Clone this repository, then copy the extension into the target repository:

```sh
git clone --depth 1 https://github.com/cschleiden/copilot-ios-simulator.git
mkdir -p <target-repository>/.github/extensions
cp -R copilot-ios-simulator/.github/extensions/ios-simulator \
  <target-repository>/.github/extensions/ios-simulator
```

Reload extensions in GitHub Copilot after copying it. No separate package or dependency installation is required.

## Usage

Ask GitHub Copilot to open the iOS Simulator. Choose an installed device from the dropdown, then use the canvas controls to interact with it, rotate it, change keyboard mode, configure stream quality, restart it, or shut it down.

You can also ask Copilot to capture the screen or interact with the selected simulator. Agent control uses an exclusive, time-limited lease so it cannot conflict with manual input.

## Agent tools

The canvas provides these tools to GitHub Copilot:

| Tool | Description |
| --- | --- |
| `diagnose_native_backend` | Build and validate the native Swift bridge. |
| `list_devices` | List available simulators and their runtime state. |
| `get_device_state` | Get state, lease, and metadata for a simulator. |
| `acquire_control` | Acquire an exclusive, time-limited control lease. |
| `renew_control` | Renew an active control lease. |
| `release_control` | Release an active control lease. |
| `set_keyboard_mode` | Switch between hardware and software keyboard modes. |
| `capture_screen` | Capture a PNG screenshot as a session artifact. |
| `start_video_recording` | Start a lease-bound H.264 recording while agent input continues. |
| `stop_video_recording` | Finalize an active recording as a QuickTime session artifact. |
| `boot_device` | Boot a simulator and wait until it is ready. |
| `shutdown_device` | Shut down a simulator. |
| `restart_device` | Shut down and boot a simulator. |
| `rotate_device` | Rotate a simulator left or right. |
| `press_button` | Press a supported simulator hardware button. |
| `tap` | Tap at normalized coordinates by default, or explicit point coordinates. |
| `swipe` | Swipe using normalized coordinates by default, or explicit point coordinates. |
| `send_key` | Send a keyboard event with optional modifiers. |
| `send_text` | Send text input. |
| `perform_inputs` | Run an ordered input sequence under one lease. |

Tools that control or capture a simulator require a lease acquired with `acquire_control`.
