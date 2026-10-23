CREATE DATABASE IF NOT EXISTS tremor_monitor
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE tremor_monitor;

CREATE TABLE IF NOT EXISTS patients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  display_name VARCHAR(120) NOT NULL,
  patient_code VARCHAR(32) NOT NULL UNIQUE,
  preferred_language VARCHAR(40) NOT NULL DEFAULT 'English',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_id BIGINT UNSIGNED NOT NULL,
  device_name VARCHAR(120) NOT NULL,
  serial_port VARCHAR(80) NULL,
  firmware_version VARCHAR(40) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_devices_patient_active (patient_id, is_active),
  CONSTRAINT fk_devices_patient FOREIGN KEY (patient_id)
    REFERENCES patients (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS readings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id BIGINT UNSIGNED NOT NULL,
  frequency_hz DECIMAL(8, 3) NOT NULL,
  amplitude_mv DECIMAL(8, 3) NOT NULL,
  severity TINYINT UNSIGNED NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_readings_device_time (device_id, recorded_at),
  KEY idx_readings_device_time (device_id, recorded_at DESC),
  KEY idx_readings_severity_time (severity, recorded_at DESC),
  CONSTRAINT chk_readings_severity CHECK (severity IN (1, 2, 3)),
  CONSTRAINT chk_readings_frequency CHECK (frequency_hz >= 0),
  CONSTRAINT chk_readings_amplitude CHECK (amplitude_mv >= 0),
  CONSTRAINT fk_readings_device FOREIGN KEY (device_id)
    REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS care_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_id BIGINT UNSIGNED NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_care_notes_patient_time (patient_id, created_at DESC),
  CONSTRAINT fk_care_notes_patient FOREIGN KEY (patient_id)
    REFERENCES patients (id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO patients (display_name, patient_code, preferred_language)
VALUES ('Samruddhi', 'PC-20481', 'English')
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

INSERT INTO devices (patient_id, device_name, serial_port, firmware_version)
SELECT id, 'Pulse sensor v2.4', 'USB-COM3', '2.4'
FROM patients
WHERE patient_code = 'PC-20481'
  AND NOT EXISTS (
    SELECT 1 FROM devices d WHERE d.patient_id = patients.id AND d.device_name = 'Pulse sensor v2.4'
  );
