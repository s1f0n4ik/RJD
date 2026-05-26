import React from 'react';
import { Box } from '@mui/material';
import { DateCalendar, PickersDay, type PickersDayProps } from '@mui/x-date-pickers';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { ru } from 'date-fns/locale'; // 🔑 русская локаль (неделя с понедельника)
import { RZD_COLORS } from '../theme';

interface RecordingsCalendarProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
  highlightDates: Date[];
}

const RecordingsCalendar: React.FC<RecordingsCalendarProps> = ({
  selectedDate,
  onDateChange,
  highlightDates,
}) => {
  const isHighlighted = (day: Date) => {
    return highlightDates.some(
      d => d.toDateString() === day.toDateString()
    );
  };

  const CustomDay = (props: PickersDayProps<Date>) => {
    const { day, ...other } = props;
    const highlighted = isHighlighted(day);

    return (
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
  };

  return (
    <Box>
      {/* 🔑 Передаём русскую локаль адаптеру */}
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