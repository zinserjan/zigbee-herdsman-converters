const exposes = require('../lib/exposes');
const fz = require('../converters/fromZigbee');
const tz = require('../converters/toZigbee');
const reporting = require('../lib/reporting');
const e = exposes.presets;
const ea = exposes.access;
const tuya = require('../lib/tuya');
const globalStore = require('../lib/store');
const ota = require('../lib/ota');
const utils = require('../lib/utils');
const {ColorMode, colorModeLookup} = require('../lib/constants');
const libColor = require('../lib/color');

const tuyaLocal = {
    dataPoints: {
        zsHeatingSetpoint: 16,
        zsChildLock: 40,
        zsTempCalibration: 104,
        zsLocalTemp: 24,
        zsBatteryVoltage: 35,
        zsComfortTemp: 101,
        zsEcoTemp: 102,
        zsHeatingSetpointAuto: 105,
        zsOpenwindowTemp: 116,
        zsOpenwindowTime: 117,
        zsErrorStatus: 45,
        zsMode: 2,
        zsAwaySetting: 103,
        zsBinaryOne: 106,
        zsBinaryTwo: 107,
        zsScheduleMonday: 109,
        zsScheduleTuesday: 110,
        zsScheduleWednesday: 111,
        zsScheduleThursday: 112,
        zsScheduleFriday: 113,
        zsScheduleSaturday: 114,
        zsScheduleSunday: 115,
    },
};

const fzLocal = {
    zs_thermostat: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataResponse', 'commandDataReport'],
        convert: (model, msg, publish, options, meta) => {
            const dpValue = tuya.firstDpValue(msg, meta, 'zs_thermostat');
            const dp = dpValue.dp;
            const value = tuya.getDataValue(dpValue);
            const ret = {};
            const daysMap = {1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday', 5: 'friday', 6: 'saturday', 7: 'sunday'};
            const day = daysMap[value[0]];

            switch (dp) {
            case tuyaLocal.dataPoints.zsChildLock:
                return {child_lock: value ? 'LOCK' : 'UNLOCK'};

            case tuyaLocal.dataPoints.zsHeatingSetpoint:
                if (value==0) ret.system_mode='off';
                if (value==60) {
                    ret.system_mode='heat';
                    ret.preset = 'boost';
                }

                ret.current_heating_setpoint= (value / 2).toFixed(1);
                if (value>0 && value<60) globalStore.putValue(msg.endpoint, 'current_heating_setpoint', ret.current_heating_setpoint);
                return ret;
            case tuyaLocal.dataPoints.zsHeatingSetpointAuto:
                return {current_heating_setpoint_auto: (value / 2).toFixed(1)};

            case tuyaLocal.dataPoints.zsOpenwindowTemp:
                return {detectwindow_temperature: (value / 2).toFixed(1)};

            case tuyaLocal.dataPoints.zsOpenwindowTime:
                return {detectwindow_timeminute: value};

            case tuyaLocal.dataPoints.zsLocalTemp:
                return {local_temperature: (value / 10).toFixed(1)};

            case tuyaLocal.dataPoints.zsBatteryVoltage:
                return {voltage: Math.round(value * 10)};

            case tuyaLocal.dataPoints.zsTempCalibration:
                return {local_temperature_calibration: value > 55 ?
                    ((value - 0x100000000)/10).toFixed(1): (value/ 10).toFixed(1)};

            case tuyaLocal.dataPoints.zsBinaryOne:
                return {binary_one: value ? 'ON' : 'OFF'};

            case tuyaLocal.dataPoints.zsBinaryTwo:
                return {binary_two: value ? 'ON' : 'OFF'};

            case tuyaLocal.dataPoints.zsComfortTemp:
                return {comfort_temperature: (value / 2).toFixed(1)};

            case tuyaLocal.dataPoints.zsEcoTemp:
                return {eco_temperature: (value / 2).toFixed(1)};

            case tuyaLocal.dataPoints.zsAwayTemp:
                return {away_preset_temperature: (value / 2).toFixed(1)};

            case tuyaLocal.dataPoints.zsMode:
                switch (value) {
                case 1: // manual
                    return {system_mode: 'heat', away_mode: 'OFF', preset: 'manual'};
                case 2: // away
                    return {system_mode: 'auto', away_mode: 'ON', preset: 'holiday'};
                case 0: // auto
                    return {system_mode: 'auto', away_mode: 'OFF', preset: 'schedule'};
                default:
                    meta.logger.warn('zigbee-herdsman-converters:zsThermostat: ' +
                        `preset ${value} is not recognized.`);
                    break;
                }
                break;
            case tuyaLocal.dataPoints.zsScheduleMonday:
            case tuyaLocal.dataPoints.zsScheduleTuesday:
            case tuyaLocal.dataPoints.zsScheduleWednesday:
            case tuyaLocal.dataPoints.zsScheduleThursday:
            case tuyaLocal.dataPoints.zsScheduleFriday:
            case tuyaLocal.dataPoints.zsScheduleSaturday:
            case tuyaLocal.dataPoints.zsScheduleSunday:
                for (let i = 1; i <= 9; i++) {
                    const tempId = ((i-1) * 2) +1;
                    const timeId = ((i-1) * 2) +2;
                    ret[`${day}_temp_${i}`] = (value[tempId] / 2).toFixed(1);
                    if (i!=9) {
                        ret[`${day}_hour_${i}`] = Math.floor(value[timeId] / 4).toString().padStart(2, '0');
                        ret[`${day}_minute_${i}`] = ((value[timeId] % 4) *15).toString().padStart(2, '0');
                    }
                }
                return ret;
            case tuyaLocal.dataPoints.zsAwaySetting:
                ret.away_preset_year = value[0];
                ret.away_preset_month = value[1];
                ret.away_preset_day = value[2];
                ret.away_preset_hour = value[3];
                ret.away_preset_minute = value[4];
                ret.away_preset_temperature = (value[5] / 2).toFixed(1);
                ret.away_preset_days = (value[6]<<8)+value[7];
                return ret;
            default:
                meta.logger.warn(`zigbee-herdsman-converters:zsThermostat: Unrecognized DP #${dp} with data ${JSON.stringify(dpValue)}`);
            }
        },
    },
    watering_time_left: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataReport'],
        convert: (model, msg, publish, options, meta) => {
            // Setup workaround for time_left reporting
            // Background: Device reports the real time_left value only on manual watering
            // for scheduled watering it will report just '0' in the beginning and at the end
            const result = {};
            let reportedState = undefined;

            for (const dpValue of msg.data.dpValues) {
                const value = tuya.getDataValue(dpValue);
                if (dpValue.dp === 1) {
                    reportedState = value ? 'ON' : 'OFF';
                    if (reportedState === 'OFF') {
                        result.time_left = 0;
                    }
                }
            }

            // Indications when the watering was triggered by scheduler:
            // - scheduling is enabled
            // - current state is on
            // - time_left is 0
            // - current hour & minute matches scheduling period
            if (
                meta.state.schedule_mode !== 'OFF' &&
                reportedState === 'ON' &&
                meta.state.time_left === 0 &&
                !globalStore.hasValue(msg.endpoint, 'watering_timer_active_time_slot')
            ) {
                const now = new Date();
                const timeslot = [1, 2, 3, 4, 5, 6]
                    .map((slotNumber) => utils.getObjectProperty(meta.state, `schedule_slot_${slotNumber}`, {}))
                    .find((ts) =>ts.state === 'ON' && ts.start_hour === now.getHours() && ts.start_minute === now.getMinutes() && ts.timer > 0);

                if (timeslot) {
                    // automatic watering detected
                    globalStore.putValue(msg.endpoint, 'watering_timer_active_time_slot', {
                        timeslot_start_timestamp: now.getTime(),
                        timer: timeslot.timer,
                        pause: timeslot.pause,
                        iteration_duration: timeslot.timer + timeslot.pause,
                        iterations: Math.max(timeslot.iterations, 1),
                        iteration_report: false, // will be set in the next step
                        iteration_timestamp: 0, // will be set in the next step
                    });
                }
            }

            // Verify that we still have to workaround the missing time_left update
            if (globalStore.hasValue(msg.endpoint, 'watering_timer_active_time_slot')) {
                const ts = globalStore.getValue(msg.endpoint, 'watering_timer_active_time_slot');
                const maximumEndTime = ts.timeslot_start_timestamp + ts.iterations * ts.iteration_duration * 60 * 1000;

                if (
                    // time slot execution is already completed
                    Date.now() > maximumEndTime ||
                    // scheduling was interrupted by turning watering on manually
                    // TODO verify that this statement still works in this minimal converter
                    (reportedState === 'ON' && reportedState != meta.state.state && meta.state.time_left > 0)
                ) {
                    // reporting is no longer necessary
                    globalStore.clearValue(msg.endpoint, 'watering_timer_active_time_slot');
                } else if (reportedState === 'OFF' && reportedState !== meta.state.state) {
                    // manually turned off --> disable reporting for this iteration
                    ts.iteration_report = false;
                } else if (reportedState === 'ON' && result.state !== meta.state.state && meta.state.time_left === 0) {
                    // automatic scheduling detected (reported as ON, but without any info about duration)
                    ts.iteration_report = true;
                    ts.iteration_timestamp = Date.now();
                }
            }

            // report manually
            if (globalStore.hasValue(msg.endpoint, 'watering_timer_active_time_slot')) {
                const wateringTimeSlot = globalStore.getValue(msg.endpoint, 'watering_timer_active_time_slot');
                if (result.time_left === undefined && wateringTimeSlot.iteration_report) {
                    const now = Date.now();
                    const wateringEndTime = wateringTimeSlot.iteration_timestamp + wateringTimeSlot.timer * 60 * 1000;
                    const timeLeftInMinutes = Math.round((wateringEndTime - now) / 1000 / 60);
                    if (timeLeftInMinutes > 0) {
                        result.time_left = timeLeftInMinutes;
                    }
                }
            }

            return result;
        },
    },
};
const tzLocal = {
    led_control: {
        key: ['brightness', 'color', 'color_temp', 'transition'],
        options: [exposes.options.color_sync()],
        convertSet: async (entity, _key, _value, meta) => {
            const newState = {};

            // The color mode encodes whether the light is using its white LEDs or its color LEDs
            let colorMode = meta.state.color_mode ?? colorModeLookup[ColorMode.ColorTemp];

            // Color mode switching is done by setting color temperature (switch to white LEDs) or setting color (switch
            // to color LEDs)
            if ('color_temp' in meta.message) colorMode = colorModeLookup[ColorMode.ColorTemp];
            if ('color' in meta.message) colorMode = colorModeLookup[ColorMode.HS];

            if (colorMode != meta.state.color_mode) {
                newState.color_mode = colorMode;

                // To switch between white mode and color mode, we have to send a special command:
                const rgbMode = (colorMode == colorModeLookup[ColorMode.HS]);
                await entity.command('lightingColorCtrl', 'tuyaRgbMode', {enable: rgbMode}, {}, {disableDefaultResponse: true});
            }

            // A transition time of 0 would be treated as about 1 second, probably some kind of fallback/default
            // transition time, so for "no transition" we use 1 (tenth of a second).
            const transtime = 'transition' in meta.message ? meta.message.transition * 10 : 1;

            if (colorMode == colorModeLookup[ColorMode.ColorTemp]) {
                if ('brightness' in meta.message) {
                    const zclData = {level: Number(meta.message.brightness), transtime};
                    await entity.command('genLevelCtrl', 'moveToLevel', zclData, utils.getOptions(meta.mapped, entity));
                    newState.brightness = meta.message.brightness;
                }

                if ('color_temp' in meta.message) {
                    const zclData = {colortemp: meta.message.color_temp, transtime: transtime};
                    await entity.command('lightingColorCtrl', 'moveToColorTemp', zclData, utils.getOptions(meta.mapped, entity));
                    newState.color_temp = meta.message.color_temp;
                }
            } else if (colorMode == colorModeLookup[ColorMode.HS]) {
                if ('brightness' in meta.message || 'color' in meta.message) {
                    // We ignore the brightness of the color and instead use the overall brightness setting of the lamp
                    // for the brightness because I think that's the expected behavior and also because the color
                    // conversion below always returns 100 as brightness ("value") even for very dark colors, except
                    // when the color is completely black/zero.

                    // Load current state or defaults
                    const newSettings = {
                        brightness: meta.state.brightness ?? 254, //      full brightness
                        hue: (meta.state.color ?? {}).hue ?? 0, //          red
                        saturation: (meta.state.color ?? {}).saturation ?? 100, // full saturation
                    };

                    // Apply changes
                    if ('brightness' in meta.message) {
                        newSettings.brightness = meta.message.brightness;
                        newState.brightness = meta.message.brightness;
                    }
                    if ('color' in meta.message) {
                        // The Z2M UI sends `{ hex:'#xxxxxx' }`.
                        // Home Assistant sends `{ h: xxx, s: xxx }`.
                        // We convert the former into the latter.
                        const c = libColor.Color.fromConverterArg(meta.message.color);
                        if (c.isRGB()) {
                            // https://github.com/Koenkk/zigbee2mqtt/issues/13421#issuecomment-1426044963
                            c.hsv = c.rgb.gammaCorrected().toXY().toHSV();
                        }
                        const color = c.hsv;

                        newSettings.hue = color.hue;
                        newSettings.saturation = color.saturation;

                        newState.color = {
                            hue: color.hue,
                            saturation: color.saturation,
                        };
                    }

                    // Convert to device specific format and send
                    const zclData = {
                        brightness: utils.mapNumberRange(newSettings.brightness, 0, 254, 0, 1000),
                        hue: newSettings.hue,
                        saturation: utils.mapNumberRange(newSettings.saturation, 0, 100, 0, 1000),
                    };
                    // This command doesn't support a transition time
                    await entity.command('lightingColorCtrl', 'tuyaMoveToHueAndSaturationBrightness2', zclData,
                        utils.getOptions(meta.mapped, entity));
                }
            }

            // If we're in white mode, calculate a matching display color for the set color temperature. This also kind
            // of works in the other direction.
            Object.assign(newState, libColor.syncColorState(newState, meta.state, entity, meta.options, meta.logger));

            return {state: newState};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', ['currentHue', 'currentSaturation', 'currentLevel', 'tuyaRgbMode', 'colorTemperature']);
        },
    },
    zs_thermostat_child_lock: {
        key: ['child_lock'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuyaLocal.dataPoints.zsChildLock, value === 'LOCK');
        },
    },
    zs_thermostat_binary_one: {
        key: ['binary_one'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuyaLocal.dataPoints.zsBinaryOne, value === 'ON');
        },
    },
    zs_thermostat_binary_two: {
        key: ['binary_two'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuyaLocal.dataPoints.zsBinaryTwo, value === 'ON');
        },
    },
    zs_thermostat_current_heating_setpoint: {
        key: ['current_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            let temp = Math.round(value * 2);
            if (temp<=0) temp = 1;
            if (temp>=60) temp = 59;
            await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsHeatingSetpoint, temp);
        },
    },
    zs_thermostat_current_heating_setpoint_auto: {
        key: ['current_heating_setpoint_auto'],
        convertSet: async (entity, key, value, meta) => {
            let temp = Math.round(value * 2);
            if (temp<=0) temp = 1;
            if (temp>=60) temp = 59;
            await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsHeatingSetpointAuto, temp);
        },
    },
    zs_thermostat_comfort_temp: {
        key: ['comfort_temperature'],
        convertSet: async (entity, key, value, meta) => {
            meta.logger.debug(JSON.stringify(entity));
            const temp = Math.round(value * 2);
            await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsComfortTemp, temp);
        },
    },
    zs_thermostat_openwindow_temp: {
        key: ['detectwindow_temperature'],
        convertSet: async (entity, key, value, meta) => {
            let temp = Math.round(value * 2);
            if (temp<=0) temp = 1;
            if (temp>=60) temp = 59;
            await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsOpenwindowTemp, temp);
        },
    },
    zs_thermostat_openwindow_time: {
        key: ['detectwindow_timeminute'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsOpenwindowTime, value);
        },
    },
    zs_thermostat_eco_temp: {
        key: ['eco_temperature'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value * 2);
            await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsEcoTemp, temp);
        },
    },
    zs_thermostat_preset_mode: {
        key: ['preset'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'schedule': 0, 'manual': 1, 'holiday': 2};
            if (value == 'boost') {
                await tuya.sendDataPointEnum(entity, tuyaLocal.dataPoints.zsMode, lookup['manual']);
                await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsHeatingSetpoint, 60);
            } else {
                await tuya.sendDataPointEnum(entity, tuyaLocal.dataPoints.zsMode, lookup[value]);
                if (value == 'manual') {
                    const temp = globalStore.getValue(entity, 'current_heating_setpoint');
                    await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsHeatingSetpoint, temp ? Math.round(temp * 2) : 43 );
                }
            }
        },
    },
    zs_thermostat_system_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            if (value == 'off') {
                await tuya.sendDataPointEnum(entity, tuyaLocal.dataPoints.zsMode, 1);
                await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsHeatingSetpoint, 0);
            } else if (value == 'auto') {
                await tuya.sendDataPointEnum(entity, tuyaLocal.dataPoints.zsMode, 0);
            } else if (value == 'heat') {
                // manual
                const temp = globalStore.getValue(entity, 'current_heating_setpoint');
                await tuya.sendDataPointEnum(entity, tuyaLocal.dataPoints.zsMode, 1);
                await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsHeatingSetpoint, temp ? Math.round(temp * 2) : 43 );
            }
        },
    },
    zs_thermostat_local_temperature_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            if (value > 0) value = value*10;
            if (value < 0) value = value*10 + 0x100000000;
            await tuya.sendDataPointValue(entity, tuyaLocal.dataPoints.zsTempCalibration, value);
        },
    },
    zs_thermostat_away_setting: {
        key: ['away_setting'],
        convertSet: async (entity, key, value, meta) => {
            const result = [];
            const daysInMonth = new Date(2000+result[0], result[1], 0).getDate();

            for (const attrName of ['away_preset_year',
                'away_preset_month',
                'away_preset_day',
                'away_preset_hour',
                'away_preset_minute',
                'away_preset_temperature',
                'away_preset_days']) {
                let v = 0;
                if (value.hasOwnProperty(attrName)) {
                    v = value[attrName];
                } else if (meta.state.hasOwnProperty(attrName)) {
                    v = meta.state[attrName];
                }
                switch (attrName) {
                case 'away_preset_year':
                    if (v<17 || v>99) v = 17;
                    result.push(Math.round(v));
                    break;
                case 'away_preset_month':
                    if (v<1 || v>12) v = 1;
                    result.push(Math.round(v));
                    break;
                case 'away_preset_day':
                    if (v<1) {
                        v = 1;
                    } else if (v>daysInMonth) {
                        v = daysInMonth;
                    }
                    result.push(Math.round(v));
                    break;
                case 'away_preset_hour':
                    if (v<0 || v>23) v = 0;
                    result.push(Math.round(v));
                    break;
                case 'away_preset_minute':
                    if (v<0 || v>59) v = 0;
                    result.push(Math.round(v));
                    break;
                case 'away_preset_temperature':
                    if (v<0.5 || v>29.5) v = 17;
                    result.push(Math.round(v * 2));
                    break;
                case 'away_preset_days':
                    if (v<1 || v>9999) v = 1;
                    result.push((v & 0xff00)>>8);
                    result.push((v & 0x00ff));
                    break;
                }
            }

            await tuya.sendDataPointRaw(entity, tuyaLocal.dataPoints.zsAwaySetting, result);
        },
    },
    zs_thermostat_local_schedule: {
        key: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
        convertSet: async (entity, key, value, meta) => {
            const daysMap = {'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6, 'sunday': 7};
            const day = daysMap[key];
            const results = [];
            results.push(day);
            for (let i = 1; i <= 9; i++) {
                // temperature
                const attrName = `${key}_temp_${i}`;
                let v = 17;
                if (value.hasOwnProperty(attrName)) {
                    v = value[attrName];
                } else if (meta.state.hasOwnProperty(attrName)) {
                    v = meta.state[attrName];
                }
                if (v<0.5 || v>29.5) v = 17;
                results.push(Math.round(v * 2));
                if (i!=9) {
                    // hour
                    let attrName = `${key}_hour_${i}`;
                    let h = 0;
                    if (value.hasOwnProperty(attrName)) {
                        h = value[attrName];
                    } else if (meta.state.hasOwnProperty(attrName)) {
                        h = meta.state[attrName];
                    }
                    // minute
                    attrName = `${key}_minute_${i}`;
                    let m = 0;
                    if (value.hasOwnProperty(attrName)) {
                        m = value[attrName];
                    } else if (meta.state.hasOwnProperty(attrName)) {
                        m = meta.state[attrName];
                    }
                    let rt = h*4 + m/15;
                    if (rt<1) {
                        rt =1;
                    } else if (rt>96) {
                        rt = 96;
                    }
                    results.push(Math.round(rt));
                }
            }
            if (value > 0) value = value*10;
            if (value < 0) value = value*10 + 0x100000000;
            await tuya.sendDataPointRaw(entity, (109+day-1), results);
        },
    },
};

const valueConverterLocal = {
    resetFrostGuard: {
        to: (value) => {
            utils.validateValue(value, ['RESET']);
            return 0;
        },
    },
    scheduleMode: {
        from: (value) => {
            const [scheduleMode, scheduleValue] = value;
            const isWeekday = scheduleMode === 0;
            return {
                schedule_mode: scheduleValue === 0 ? 'OFF' : isWeekday ? 'WEEKDAY' : 'PERIODIC',
                schedule_periodic: !isWeekday ? scheduleValue : 0,
                schedule_weekday: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
                    .reduce(
                        (scheduleMap, dayName, index) => (
                            {
                                ...scheduleMap,
                                [dayName]: isWeekday && (scheduleValue & (1 << index)) > 0 ? 'ON' : 'OFF',
                            }
                        ),
                        {},
                    ),
            };
        },
    },
    schedulePeriodic: {
        to: (value) => {
            const scheduleValue = utils.numberWithinRange(value, 0, 6);
            // Note: value of 0 switches to disabled weekday scheduler
            const scheduleMode = scheduleValue > 0 ? 1 : 0;
            return [scheduleMode, scheduleValue];
        },
    },
    scheduleWeekday: {
        to: (value, meta) => {
            // map each day to ON/OFF and use current state as default to allow partial updates
            const dayValues = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
                .map((dayName) => utils.getObjectProperty(value, dayName, utils.getObjectProperty(meta.state.schedule_weekday, dayName, 'OFF')));

            const scheduleValue = dayValues.reduce((dayConfig, value, index) => {
                return dayConfig | (value === 'ON' ? 1 << index : 0);
            }, 0);

            // value of 0 switches to weekday scheduler
            const scheduleMode = 0;

            return [scheduleMode, scheduleValue];
        },
    },
    scheduleSlot: (timeSlotNumber) => ({
        from: (buffer) => {
            return {
                state: buffer.readUInt8(0) === 1 ? 'ON' : 'OFF',
                start_hour: utils.numberWithinRange(buffer.readUInt8(1), 0, 23), // device reports 255 initially when timeslot was never used before
                start_minute: utils.numberWithinRange(buffer.readUInt8(2), 0, 59), // device reports 255 initially when timeslot was never used before
                timer: buffer.readUInt8(3) * 60 + buffer.readUInt8(4),
                pause: buffer.readUInt8(6) * 60 + buffer.readUInt8(7),
                iterations: buffer.readUInt8(9),
            };
        },
        to: (value, meta) => {
            // fallback to values from current config to allow partial updates
            const timeslot = utils.getObjectProperty(meta.state, `schedule_slot_${timeSlotNumber}`, {});

            const state = utils.getObjectProperty(value, 'state', timeslot.state);
            const startHour = utils.getObjectProperty(value, 'start_hour', timeslot.start_hour);
            const startMinute = utils.getObjectProperty(value, 'start_minute', timeslot.start_minute);
            const totalDurationInMinutes = utils.getObjectProperty(value, 'timer', timeslot.timer);
            const durationHours = Math.floor(totalDurationInMinutes / 60);
            const durationMinutes = totalDurationInMinutes % 60;
            const totalPauseInMinutes = utils.getObjectProperty(value, 'pause', timeslot.pause);
            const pauseHours = Math.floor(totalPauseInMinutes / 60);
            const pauseMinutes = totalPauseInMinutes % 60;
            const iterations = utils.getObjectProperty(value, 'iterations', timeslot.iterations);

            if (iterations > 1 && totalPauseInMinutes === 0) {
                throw new Error(`Pause value must be at least 1 minute when using multiple iterations!`);
            }

            return [
                state === 'ON' ? 1 : 0, // time slot enabled or not
                startHour, // start hour
                startMinute, // start minute
                durationHours, // duration for n hours
                durationMinutes, // + n minutes
                0, // ??? -> always 0
                pauseHours, // pause in hours
                pauseMinutes, // pause in minutes
                0, // ??? -> always 0
                iterations, // iterations
            ];
        },
    }),
};

module.exports = [
    {
        fingerprint: [
            {manufacturerName: '_TZ3000_kdi2o9m6'}, // EU
            {modelID: 'TS011F', manufacturerName: '_TZ3000_plyvnuf5'}, // CH
            {modelID: 'TS011F', manufacturerName: '_TZ3000_wamqdr3f'}, // FR
            {modelID: 'TS011F', manufacturerName: '_TZ3000_00mk2xzy'}, // BS
            {modelID: 'TS011F', manufacturerName: '_TZ3000_upjrsxh1'}, // DK
            {manufacturerName: '_TZ3000_00mk2xzy'}, // BS
        ],
        model: 'HG06337',
        vendor: 'Lidl',
        description: 'Silvercrest smart plug (EU, CH, FR, BS, DK)',
        extend: tuya.extend.switch(),
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(11);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            await reporting.onOff(endpoint);
        },
    },
    {
        fingerprint: [
            {modelID: 'TS011F', manufacturerName: '_TZ3000_j1v25l17'}, // EU
            {modelID: 'TS011F', manufacturerName: '_TZ3000_ynmowqk2'}, // FR
        ],
        model: 'HG08673',
        vendor: 'Lidl',
        description: 'Silvercrest smart plug with power monitoring (EU, FR)',
        ota: ota.zigbeeOTA,
        extend: tuya.extend.switch({electricalMeasurements: true, powerOutageMemory: true, indicatorMode: true, childLock: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'haElectricalMeasurement']);
            await reporting.rmsVoltage(endpoint, {change: 5});
            await reporting.rmsCurrent(endpoint, {change: 50});
            await reporting.activePower(endpoint, {change: 10});
            // Energy reporting (currentSummDelivered) doesn't work; requires polling: https://github.com/Koenkk/zigbee2mqtt/issues/14356
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {acCurrentDivisor: 1000, acCurrentMultiplier: 1});
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            device.save();
        },
        options: [exposes.options.measurement_poll_interval().withDescription('Only the energy value is polled for this device.')],
        onEvent: (type, data, device, options) => tuya.onEventMeasurementPoll(type, data, device, options, false, true),
    },
    {
        fingerprint: [{modelID: 'TS004F', manufacturerName: '_TZ3000_rco1yzb1'}],
        model: 'HG08164',
        vendor: 'Lidl',
        description: 'Silvercrest smart button',
        fromZigbee: [fz.command_on, fz.command_off, fz.command_step, fz.command_stop, fz.battery, fz.tuya_on_off_action],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
        exposes: [e.action(
            ['on', 'off', 'brightness_stop', 'brightness_step_up', 'brightness_step_down', 'single', 'double']), e.battery()],
    },
    {
        fingerprint: [{modelID: 'TS0211', manufacturerName: '_TZ1800_ladpngdx'}],
        model: 'HG06668',
        vendor: 'Lidl',
        description: 'Silvercrest smart wireless door bell button',
        fromZigbee: [fz.battery, fz.tuya_doorbell_button, fz.ignore_basic_report],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
        exposes: [e.battery(), e.action(['pressed']), e.battery_low(), e.tamper()],
    },
    {
        fingerprint: [{modelID: 'TY0202', manufacturerName: '_TZ1800_fcdjzz3s'}],
        model: 'HG06335/HG07310',
        vendor: 'Lidl',
        description: 'Silvercrest smart motion sensor',
        fromZigbee: [fz.ias_occupancy_alarm_1, fz.battery],
        toZigbee: [],
        exposes: [e.occupancy(), e.battery_low(), e.tamper(), e.battery()],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.batteryVoltage(endpoint);
            await reporting.batteryPercentageRemaining(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TY0203', manufacturerName: '_TZ1800_ejwkn2h2'}],
        model: 'HG06336',
        vendor: 'Lidl',
        description: 'Silvercrest smart window and door sensor',
        fromZigbee: [fz.ias_contact_alarm_1, fz.ias_contact_alarm_1_report, fz.battery],
        toZigbee: [],
        exposes: [e.contact(), e.battery_low(), e.tamper(), e.battery()],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS1001', manufacturerName: '_TYZB01_bngwdjsr'}],
        model: 'FB20-002',
        vendor: 'Lidl',
        description: 'Livarno Lux switch and dimming light remote control',
        exposes: [e.action(['on', 'off', 'brightness_stop', 'brightness_step_up', 'brightness_step_down', 'brightness_move_up',
            'brightness_move_down'])],
        fromZigbee: [fz.command_on, fz.command_off, fz.command_step, fz.command_move, fz.command_stop],
        toZigbee: [],
    },
    {
        fingerprint: [{modelID: 'TS1001', manufacturerName: '_TYZB01_hww2py6b'}],
        model: 'FB21-001',
        vendor: 'Lidl',
        description: 'Livarno Lux switch and dimming light remote control',
        exposes: [e.action(['on', 'off', 'brightness_stop', 'brightness_step_up', 'brightness_step_down', 'brightness_move_up',
            'brightness_move_down', 'switch_scene'])],
        fromZigbee: [fz.command_on, fz.command_off, fz.command_step, fz.command_move, fz.command_stop, fz.tuya_switch_scene],
        toZigbee: [],
    },
    {
        fingerprint: [
            {modelID: 'TS011F', manufacturerName: '_TZ3000_wzauvbcs'}, // EU
            {modelID: 'TS011F', manufacturerName: '_TZ3000_oznonj5q'},
            {modelID: 'TS011F', manufacturerName: '_TZ3000_1obwwnmq'},
            {modelID: 'TS011F', manufacturerName: '_TZ3000_4uf3d0ax'}, // FR
            {modelID: 'TS011F', manufacturerName: '_TZ3000_vzopcetz'}, // CZ
            {modelID: 'TS011F', manufacturerName: '_TZ3000_vmpbygs5'}, // BS
        ],
        model: 'HG06338',
        vendor: 'Lidl',
        description: 'Silvercrest 3 gang switch, with 4 USB (EU, FR, CZ, BS)',
        extend: tuya.extend.switch({endpoints: ['l1', 'l2', 'l3']}),
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            for (const ID of [1, 2, 3]) {
                await reporting.bind(device.getEndpoint(ID), coordinatorEndpoint, ['genOnOff']);
            }
        },
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2, 'l3': 3};
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_s8gkrkxk'}],
        model: 'HG06467',
        vendor: 'Lidl',
        description: 'Melinera smart LED string lights',
        toZigbee: [tz.on_off, tz.silvercrest_smart_led_string],
        fromZigbee: [fz.on_off, fz.silvercrest_smart_led_string],
        exposes: [e.light_brightness_colorhs().setAccess('brightness', ea.STATE_SET).setAccess('color_hs', ea.STATE_SET)],
    },
    {
        fingerprint: [{modelID: 'TS0504B', manufacturerName: '_TZ3210_sroezl0s'}],
        model: '14153806L',
        vendor: 'Lidl',
        description: 'Livarno smart LED ceiling light',
        extend: tuya.extend.light_onoff_brightness_colortemp_color({colorTempRange: [153, 500], noConfigure: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            device.getEndpoint(1).saveClusterAttributeKeyValue('lightingColorCtrl', {colorCapabilities: 29});
        },
    },
    {
        fingerprint: [{modelID: 'TS0505B', manufacturerName: '_TZ3210_iystcadi'}],
        model: '14149505L/14149506L_2',
        vendor: 'Lidl',
        description: 'Livarno Lux light bar RGB+CCT (black/white)',
        toZigbee: [tz.on_off, tzLocal.led_control],
        fromZigbee: [fz.on_off, fz.tuya_led_controller, fz.brightness, fz.ignore_basic_report],
        exposes: [e.light_brightness_colortemp_colorhs([153, 500]).removeFeature('color_temp_startup')],
        configure: async (device, coordinatorEndpoint, logger) => {
            device.getEndpoint(1).saveClusterAttributeKeyValue('lightingColorCtrl', {colorCapabilities: 29});
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_htnnfasr'}],
        model: 'PSBZS A1',
        vendor: 'Lidl',
        description: 'Parkside smart watering timer',
        fromZigbee: [fz.ignore_basic_report, fz.ignore_tuya_set_time, fz.ignore_onoff_report, tuya.fz.datapoints, fz.watering_time_left],
        toZigbee: [tz.on_off, tz.lidl_watering_timer],
        onEvent: async (type, data, device) => {
            await tuya.onEventSetLocalTime(type, data, device);

            if (type === 'deviceInterview' && data.status === 'successful') {
                // dirty hack: reset frost guard & frost alarm to get the initial state
                // wait 10 seconds to ensure configure is done
                await utils.sleep(10000);
                const endpoint = device.getEndpoint(1);
                try {
                    await tuya.sendDataPointBool(endpoint, 109, false);
                    await tuya.sendDataPointBool(endpoint, 108, false);
                } catch (e) {
                    // ignore, just prevent any crashes
                }
            }
        },
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);

            // set reporting interval of genOnOff to max to "disable" it
            // background: genOnOff reporting does not respect timer or button, that makes the on/off reporting pretty useless
            // the device is reporting it's state change anyway via tuya DPs
            await reporting.onOff(device.getEndpoint(1), {max: 0xffff});
        },
        exposes: [
            e.battery(),
            tuya.exposes.switch(),
            exposes
                .numeric('timer', ea.STATE_SET)
                .withValueMin(1)
                .withValueMax(9 * 60 + 59)
                .withUnit('min')
                .withDescription('Auto off after specific time for manual watering.'),
            exposes
                .numeric('time_left', ea.STATE)
                .withUnit('min')
                .withDescription('Remaining time until the watering turns off.'),
            exposes
                .binary('frost_guard', ea.STATE, 'ON', 'OFF')
                .withDescription(
                    'Indicates if the frost guard is currently active. ' +
                    'If the temperature drops below 5° C, device activates frost guard and disables irrigation. ' +
                    'You need to reset the frost guard to activate irrigation again. Note: There is no way to enable frost guard manually.',
                ),
            exposes
                .enum('reset_frost_guard', ea.SET, ['RESET'])
                .withDescription('Resets frost_guard to make the device workable again.'),
            exposes
                .enum('schedule_mode', ea.STATE, ['OFF', 'WEEKDAY', 'PERIODIC'])
                .withDescription('Scheduling mode that is currently in use.'),
            exposes
                .numeric('schedule_periodic', ea.STATE_SET)
                .withValueMin(0)
                .withValueMax(6)
                .withUnit('day')
                .withDescription('Watering by periodic interval: Irrigate every n days'),
            exposes
                .composite('schedule_weekday', 'schedule_weekday')
                .withDescription('Watering by weekday: Irrigate individually for each day.')
                .withFeature(exposes.binary('monday', ea.STATE_SET, 'ON', 'OFF'))
                .withFeature(exposes.binary('tuesday', ea.STATE_SET, 'ON', 'OFF'))
                .withFeature(exposes.binary('wednesday', ea.STATE_SET, 'ON', 'OFF'))
                .withFeature(exposes.binary('thursday', ea.STATE_SET, 'ON', 'OFF'))
                .withFeature(exposes.binary('friday', ea.STATE_SET, 'ON', 'OFF'))
                .withFeature(exposes.binary('saturday', ea.STATE_SET, 'ON', 'OFF'))
                .withFeature(exposes.binary('sunday', ea.STATE_SET, 'ON', 'OFF')),
            ...[1, 2, 3, 4, 5, 6].map((timeSlotNumber) =>
                exposes
                    .composite(`schedule_slot_${timeSlotNumber}`, `schedule_slot_${timeSlotNumber}`)
                    .withDescription(`Watering time slot ${timeSlotNumber}`)
                    .withFeature(
                        exposes.binary('state', ea.STATE_SET, 'ON', 'OFF').withDescription('On/off state of the time slot'),
                    )
                    .withFeature(
                        exposes
                            .numeric('start_hour', ea.STATE_SET)
                            .withUnit('h')
                            .withValueMin(0)
                            .withValueMax(23)
                            .withDescription('Starting time (hour)'),
                    )
                    .withFeature(
                        exposes
                            .numeric('start_minute', ea.STATE_SET)
                            .withUnit('min')
                            .withValueMin(0)
                            .withValueMax(59)
                            .withDescription('Starting time (minute)'),
                    )
                    .withFeature(
                        exposes
                            .numeric('timer', ea.STATE_SET)
                            .withUnit('min')
                            .withValueMin(1)
                            .withValueMax(9 * 60 + 59)
                            .withDescription('Auto off after specific time for scheduled watering.'),
                    )
                    .withFeature(
                        exposes
                            .numeric('pause', ea.STATE_SET)
                            .withUnit('min')
                            .withValueMin(0)
                            .withValueMax(9 * 60 + 59)
                            .withDescription('Pause after each iteration.'),
                    )
                    .withFeature(
                        exposes
                            .numeric('iterations', ea.STATE_SET)
                            .withValueMin(1)
                            .withValueMax(9)
                            .withDescription('Number of watering iterations. Works only if there is a pause.'),
                    ),
            ),
        ],
        meta: {
            tuyaDatapoints: [
                // disable optimistic state reporting (device may not turn on when battery is low)
                [1, 'state', tuya.valueConverter.onOff, {optimistic: false}],
                [5, 'timer', tuya.valueConverter.raw],
                [6, 'time_left', tuya.valueConverter.raw],
                [11, 'battery', tuya.valueConverter.raw],
                [108, 'frost_guard', tuya.valueConverter.onOff],
                // there is no state reporting for reset
                [109, 'reset_frost_guard', valueConverterLocal.resetFrostGuard, {optimistic: false}],
                [107, null, valueConverterLocal.scheduleMode],
                [107, 'schedule_periodic', valueConverterLocal.schedulePeriodic],
                [107, 'schedule_weekday', valueConverterLocal.scheduleWeekday],
                [101, 'schedule_slot_1', valueConverterLocal.scheduleSlot(1)],
                [102, 'schedule_slot_2', valueConverterLocal.scheduleSlot(2)],
                [103, 'schedule_slot_3', valueConverterLocal.scheduleSlot(3)],
                [104, 'schedule_slot_4', valueConverterLocal.scheduleSlot(4)],
                [105, 'schedule_slot_5', valueConverterLocal.scheduleSlot(5)],
                [106, 'schedule_slot_6', valueConverterLocal.scheduleSlot(6)],
            ],
        },
    },
    {
        fingerprint: [{modelID: 'TS0101', manufacturerName: '_TZ3000_br3laukf'}],
        model: 'HG06620',
        vendor: 'Lidl',
        description: 'Silvercrest garden spike with 2 sockets',
        extend: tuya.extend.switch(),
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            await reporting.onOff(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0101', manufacturerName: '_TZ3000_pnzfdr9y'}],
        model: 'HG06619',
        vendor: 'Lidl',
        description: 'Silvercrest outdoor plug',
        extend: tuya.extend.switch(),
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            await reporting.onOff(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0505B', manufacturerName: '_TZ3000_lxw3zcdk'}],
        model: 'HG08633',
        vendor: 'Lidl',
        description: 'Livarno gardenspot RGB',
        extend: tuya.extend.light_onoff_brightness_colortemp_color({supportsHS: true, preferHS: true, colorTempRange: [153, 500]}),
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_chyvmhay'}],
        model: '368308_2010',
        vendor: 'Lidl',
        description: 'Silvercrest radiator valve with thermostat',
        fromZigbee: [fz.ignore_tuya_set_time, fzLocal.zs_thermostat],
        toZigbee: [tzLocal.zs_thermostat_current_heating_setpoint, tzLocal.zs_thermostat_child_lock,
            tzLocal.zs_thermostat_comfort_temp, tzLocal.zs_thermostat_eco_temp, tzLocal.zs_thermostat_preset_mode,
            tzLocal.zs_thermostat_system_mode, tzLocal.zs_thermostat_local_temperature_calibration,
            tzLocal.zs_thermostat_current_heating_setpoint_auto, tzLocal.zs_thermostat_openwindow_time,
            tzLocal.zs_thermostat_openwindow_temp, tzLocal.zs_thermostat_binary_one, tzLocal.zs_thermostat_binary_two,
            tzLocal.zs_thermostat_away_setting, tzLocal.zs_thermostat_local_schedule],
        onEvent: tuya.onEventSetLocalTime,
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genBasic']);
        },
        exposes: [
            e.child_lock(), e.comfort_temperature(), e.eco_temperature(), e.battery_voltage(),
            exposes.numeric('current_heating_setpoint_auto', ea.STATE_SET).withValueMin(0.5).withValueMax(29.5)
                .withValueStep(0.5).withUnit('°C').withDescription('Temperature setpoint automatic'),
            exposes.climate().withSetpoint('current_heating_setpoint', 0.5, 29.5, 0.5, ea.STATE_SET)
                .withLocalTemperature(ea.STATE).withLocalTemperatureCalibration(-12.5, 5.5, 0.1, ea.STATE_SET)
                .withSystemMode(['off', 'heat', 'auto'], ea.STATE_SET)
                .withPreset(['schedule', 'manual', 'holiday', 'boost']),
            exposes.numeric('detectwindow_temperature', ea.STATE_SET).withUnit('°C').withDescription('Open window detection temperature')
                .withValueMin(-10).withValueMax(35),
            exposes.numeric('detectwindow_timeminute', ea.STATE_SET).withUnit('min').withDescription('Open window time in minute')
                .withValueMin(0).withValueMax(1000),
            exposes.binary('binary_one', ea.STATE_SET, 'ON', 'OFF').withDescription('Unknown binary one'),
            exposes.binary('binary_two', ea.STATE_SET, 'ON', 'OFF').withDescription('Unknown binary two'),
            exposes.binary('away_mode', ea.STATE, 'ON', 'OFF').withDescription('Away mode'),
            exposes.composite('away_setting', 'away_setting', ea.STATE_SET)
                .withFeature(e.away_preset_days()).setAccess('away_preset_days', ea.ALL)
                .withFeature(e.away_preset_temperature()).setAccess('away_preset_temperature', ea.ALL)
                .withFeature(exposes.numeric('away_preset_year', ea.ALL).withUnit('year').withDescription('Start away year 20xx'))
                .withFeature(exposes.numeric('away_preset_month', ea.ALL).withUnit('month').withDescription('Start away month'))
                .withFeature(exposes.numeric('away_preset_day', ea.ALL).withUnit('day').withDescription('Start away day'))
                .withFeature(exposes.numeric('away_preset_hour', ea.ALL).withUnit('hour').withDescription('Start away hours'))
                .withFeature(exposes.numeric('away_preset_minute', ea.ALL).withUnit('min').withDescription('Start away minutes')),
            ...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => {
                const expose = exposes.composite(day, day, ea.STATE_SET);
                [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((i) => {
                    expose.withFeature(exposes.numeric(`${day}_temp_${i}`, ea.ALL).withValueMin(0.5)
                        .withValueMax(29.5).withValueStep(0.5).withUnit('°C').withDescription(`Temperature ${i}`));
                    expose.withFeature(exposes.enum(`${day}_hour_${i}`, ea.STATE_SET,
                        ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09',
                            '10', '11', '12', '13', '14', '15', '16', '17', '18', '19',
                            '20', '21', '22', '23', '24']).withDescription(`Hour TO for temp ${i}`));
                    expose.withFeature(exposes.enum(`${day}_minute_${i}`, ea.STATE_SET, ['00', '15', '30', '45'])
                        .withDescription(`Minute TO for temp ${i}`));
                });
                return expose;
            }),
        ],
    },
];
