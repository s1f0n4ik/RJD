import React from 'react';
import { Box, Tooltip } from '@mui/material';
import { DateCalendar, PickersDay, type PickersDayProps } from '@mui/x-date-pickers';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { ru } from 'date-fns/locale';
import { RZD_COLORS } from '../theme';

interface RecordingsCalendarProps {
    selectedDate: Date;
    onDateChange: (date: Date) => void;
    highlightDates: Date[];
    /** Map<YYYY-MM-DD, количество записей>. Опциональный — если не передан, tooltip не показывается. */
    recordingCounts?: Map<string, number>;
}

// Ключ для Map: дата в формате YYYY-MM-DD (по локальному времени, без UTC-сдвига)
const dateToKey = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

// Правильное склонение: 1 запись, 2 записи, 5 записей
const formatRecordingsCount = (n: number): string => {
    const lastTwo = n % 100;
    if (lastTwo >= 11 && lastTwo <= 14) return `${n} записей`;
    const last = n % 10;
    if (last === 1) return `${n} запись`;
    if (last >= 2 && last <= 4) return `${n} записи`;
    return `${n} записей`;
};

const RecordingsCalendar: React.FC<RecordingsCalendarProps> = ({
                                                                   selectedDate,
                                                                   onDateChange,
                                                                   highlightDates,
                                                                   recordingCounts,
                                                               }) => {
    console.log('[Calendar] render');
    const isHighlighted = (day: Date) => {
        return highlightDates.some(d => d.toDateString() === day.toDateString());
    };

    const CustomDay = (props: PickersDayProps<Date>) => {
        const { day, ...other } = props;
        const highlighted = isHighlighted(day);
        const count = recordingCounts?.get(dateToKey(day)) ?? 0;

        const pickersDay = (
            <PickersDay
                {...other}
                day={day}
                sx={{
                    ...(highlighted && {
                        bgcolor: RZD_COLORS.secondary + '40',
                        fontWeight: 'bold',
                        '&:hover': {
                            bgcolor: RZD_COLORS.secondary + '80',
                        },
                    }),
                }}
            />
        );

        // Tooltip только если есть что показать
        if (count === 0) return pickersDay;

        return (
            <Tooltip
                title={formatRecordingsCount(count)}
                placement="top"
                arrow
                enterDelay={300}
                leaveDelay={0}
                disableFocusListener
                disableTouchListener
            >
                {/* span — Tooltip требует child, который принимает ref */}
                <span style={{ display: 'inline-flex' }}>
                  {pickersDay}
                </span>
            </Tooltip>
        );
    };

    return (
        <Box>
            <LocalizationProvider dateAdapter={AdapterDateFns} adapterLocale={ru}>
                <DateCalendar
                    value={selectedDate}
                    onChange={(newDate) => newDate && onDateChange(newDate)}
                    slots={{ day: CustomDay }}
                    sx={{
                        width: '100%',
                        '& .MuiPickersCalendarHeader-root': {
                            color: RZD_COLORS.primary,
                        },
                    }}
                />
            </LocalizationProvider>
        </Box>
    );
};

export default RecordingsCalendar;